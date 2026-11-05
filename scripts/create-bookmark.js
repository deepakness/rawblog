import fs from "fs";
import path from "path";
import { formatSiteDateTime, openInEditor, rootDir } from "./lib/create-utils.js";

const BOOKMARKS_FILE = path.join(rootDir, "_data", "bookmarks.json");
const FETCH_TIMEOUT_MS = 15000;

function parseArgs(argv) {
	const url = argv[2];
	const flags = {};

	if (!url || url.startsWith("--")) {
		return { url: null, flags };
	}

	for (let i = 3; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const key = argv[i].slice(2);
			const next = argv[i + 1];
			flags[key] = next && !next.startsWith("--") ? argv[++i] : true;
		}
	}

	return { url, flags };
}

function normalizeUrl(url) {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (key.startsWith("utm_")) parsed.searchParams.delete(key);
		}
		parsed.hash = "";
		let normalized = parsed.toString();
		if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
		return normalized;
	} catch {
		return url;
	}
}

function safeNormalizeUrl(url) {
	try {
		return normalizeUrl(url);
	} catch {
		return url;
	}
}

function decodeHtmlEntities(text) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/");
}

function extractMetaContent(html, patterns) {
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return decodeHtmlEntities(match[1].trim());
		}
	}
	return null;
}

function extractJsonLdAuthor(html) {
	const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
	if (!scripts) return null;

	for (const script of scripts) {
		const contentMatch = script.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
		if (!contentMatch?.[1]) continue;

		try {
			const data = JSON.parse(contentMatch[1].trim());
			const items = Array.isArray(data) ? data : [data];
			for (const item of items) {
				if (!item?.author) continue;
				if (typeof item.author === "string") return item.author;
				if (Array.isArray(item.author)) {
					const names = item.author
						.map((author) => (typeof author === "string" ? author : author?.name))
						.filter(Boolean);
					if (names.length > 0) return names.join(", ");
				}
				if (typeof item.author === "object" && item.author.name) {
					return item.author.name;
				}
			}
		} catch {
			// ignore invalid JSON-LD blocks
		}
	}

	return null;
}

function extractMetadata(html, url) {
	const title =
		extractMetaContent(html, [
			/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
			/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
			/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
			/<title[^>]*>([^<]+)<\/title>/i,
		]) || new URL(url).hostname;

	const author =
		extractMetaContent(html, [
			/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
			/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i,
			/<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
			/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:author["']/i,
			/<meta[^>]+name=["']twitter:creator["'][^>]+content=["']([^"']+)["']/i,
		]) ||
		extractJsonLdAuthor(html) ||
		new URL(url).hostname.replace(/^www\./, "");

	return { title, author };
}

async function fetchMetadata(url) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "rawblog-bookmark/1.0",
				Accept: "text/html,application/xhtml+xml",
			},
			redirect: "follow",
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const html = await response.text();
		return extractMetadata(html, url);
	} finally {
		clearTimeout(timeout);
	}
}

function loadBookmarks() {
	if (!fs.existsSync(BOOKMARKS_FILE)) {
		return [];
	}
	try {
		const data = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, "utf-8"));
		return Array.isArray(data) ? data : [];
	} catch (error) {
		console.error(`Error reading ${BOOKMARKS_FILE}: ${error.message}`);
		process.exit(1);
	}
}

function saveBookmarks(bookmarks) {
	fs.writeFileSync(BOOKMARKS_FILE, `${JSON.stringify(bookmarks, null, "\t")}\n`);
}

async function main() {
	const { url, flags } = parseArgs(process.argv);

	if (!url) {
		console.error("Please provide a URL to bookmark");
		console.error("Example: pnpm bookmark https://example.com/article");
		console.error("Flags: --note, --title, --author, --no-fetch, --force");
		process.exit(1);
	}

	let normalizedUrl;
	try {
		normalizedUrl = normalizeUrl(url);
	} catch {
		console.error(`Invalid URL: ${url}`);
		process.exit(1);
	}

	const bookmarks = loadBookmarks();
	const existing = bookmarks.find((bookmark) => safeNormalizeUrl(bookmark.url) === normalizedUrl);

	if (existing && !flags.force) {
		console.error(`Bookmark already exists: ${existing.title}`);
		console.error(`URL: ${existing.url}`);
		console.error("Use --force to add anyway.");
		process.exit(1);
	}

	let title = flags.title || "";
	let author = flags.author || "";

	if (!flags["no-fetch"] && (!title || !author)) {
		try {
			console.log(`Fetching metadata from ${normalizedUrl}...`);
			const metadata = await fetchMetadata(normalizedUrl);
			title = title || metadata.title;
			author = author || metadata.author;
		} catch (error) {
			console.warn(`Warning: Could not fetch metadata (${error.message})`);
			title = title || normalizedUrl;
			author = author || new URL(normalizedUrl).hostname.replace(/^www\./, "");
		}
	} else {
		title = title || normalizedUrl;
		author = author || new URL(normalizedUrl).hostname.replace(/^www\./, "");
	}

	const entry = {
		url: normalizedUrl,
		title,
		author,
		dateAdded: formatSiteDateTime(),
	};

	if (flags.note) {
		entry.note = flags.note;
	}

	const updated = [entry, ...bookmarks.filter((bookmark) => safeNormalizeUrl(bookmark.url) !== normalizedUrl)];
	saveBookmarks(updated);

	console.log("\n✓ Bookmark added");
	console.log(`  Title:  ${entry.title}`);
	console.log(`  Author: ${entry.author}`);
	if (entry.note) console.log(`  Note:   ${entry.note}`);
	console.log(`  File:   ${BOOKMARKS_FILE}`);

	console.log("\nOpening the file...");
	openInEditor(BOOKMARKS_FILE);
}

main().catch((error) => {
	console.error("Error:", error.message);
	process.exit(1);
});
