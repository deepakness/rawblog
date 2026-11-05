import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./lib/log.js";
import site, { SITE_HOST } from "../_config/site.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT_DIR, "content");

const MASTODON_INSTANCE = (site.mastodon?.instance || "").replace(/\/$/, "");
const MASTODON_USERNAME = site.mastodon?.username || "";
const BLOG_DOMAIN = SITE_HOST;

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

async function fetchAccountId() {
	const url = `${MASTODON_INSTANCE}/api/v1/accounts/lookup?acct=${MASTODON_USERNAME}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch account: ${response.status}`);
	}
	const account = await response.json();
	return account.id;
}

async function fetchAllStatuses(accountId) {
	const statuses = [];
	let maxId = null;
	let page = 1;

	while (true) {
		const url = new URL(`${MASTODON_INSTANCE}/api/v1/accounts/${accountId}/statuses`);
		url.searchParams.set("limit", "40");
		url.searchParams.set("exclude_reblogs", "true");
		if (maxId) {
			url.searchParams.set("max_id", maxId);
		}

		log.verb(`fetching page ${page}`);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch statuses: ${response.status}`);
		}

		const batch = await response.json();
		if (batch.length === 0) break;

		statuses.push(...batch);
		maxId = batch[batch.length - 1].id;
		page++;

		// Small delay to be nice to the API
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	return statuses;
}

function extractLinksFromHtml(html) {
	const links = [];
	const regex = /href="([^"]+)"/g;
	let match;
	while ((match = regex.exec(html)) !== null) {
		links.push(match[1]);
	}
	return links;
}

function parseSiteUrl(url) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== BLOG_DOMAIN && parsed.hostname !== `www.${BLOG_DOMAIN}`) {
			return null;
		}

		const match = parsed.pathname.match(/^\/(blog|raw)\/([^/]+)\/?$/);
		if (match) {
			return { type: match[1], slug: match[2] };
		}
		return null;
	} catch {
		return null;
	}
}

function findMarkdownFile(type, slug) {
	const possiblePaths = [path.join(CONTENT_DIR, type, slug, "index.md"), path.join(CONTENT_DIR, type, `${slug}.md`)];

	for (const filePath of possiblePaths) {
		if (fs.existsSync(filePath)) {
			return filePath;
		}
	}
	return null;
}

function hasMastodonField(content) {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return false;
	return /^mastodon:/m.test(frontmatterMatch[1]);
}

// Insert mastodon field into frontmatter in standard order (right before tags or frontmatter close)
function insertMastodonField(content, mastodonUrl) {
	if (/^tags:/m.test(content)) {
		return content.replace(/^tags:/m, `mastodon: "${mastodonUrl}"\ntags:`);
	}
	return content.replace(/\n---/, `\nmastodon: "${mastodonUrl}"\n---`);
}

function findContentFiles(onlyMissing = true) {
	const files = [];
	const contentTypes = ["blog", "raw"];

	for (const type of contentTypes) {
		const typeDir = path.join(CONTENT_DIR, type);
		if (!fs.existsSync(typeDir)) continue;

		const entries = fs.readdirSync(typeDir, { withFileTypes: true });
		for (const entry of entries) {
			let filePath;
			if (entry.isDirectory()) {
				filePath = path.join(typeDir, entry.name, "index.md");
			} else if (entry.name.endsWith(".md")) {
				filePath = path.join(typeDir, entry.name);
			} else {
				continue;
			}

			if (!fs.existsSync(filePath)) continue;

			const content = fs.readFileSync(filePath, "utf-8");
			const hasMastodon = hasMastodonField(content);

			if (!onlyMissing || !hasMastodon) {
				const slug = entry.isDirectory() ? entry.name : entry.name.replace(".md", "");
				files.push({ type, slug, filePath, hasMastodon });
			}
		}
	}

	return files;
}

async function main() {
	if (!MASTODON_INSTANCE || !MASTODON_USERNAME) {
		log.info("mastodon", "skipped — set mastodon.instance and mastodon.username in site.config.js");
		process.exit(0);
	}

	log.banner("mastodon");
	if (DRY_RUN) {
		log.info("mastodon", "dry run — no files will be modified");
	}
	if (FORCE) {
		log.info("mastodon", "force — will overwrite existing mastodon fields");
	}

	const filesToUpdate = findContentFiles(!FORCE);
	const label = FORCE ? "files to check" : "files missing mastodon field";
	log.verb(`found ${filesToUpdate.length} ${label}`);

	if (filesToUpdate.length === 0) {
		log.step("mastodon", "nothing to do — all files have a mastodon field");
		return;
	}

	const updateSet = new Set(filesToUpdate.map((f) => `${f.type}/${f.slug}`));

	log.verb(`looking up @${MASTODON_USERNAME}`);
	const accountId = await fetchAccountId();
	log.verb(`account id ${accountId}`);

	const statuses = await fetchAllStatuses(accountId);
	log.verb(`found ${statuses.length} statuses`);

	// Build map of blog URLs to mastodon URLs (earliest status per slug)
	const matchMap = new Map(); // key: "type/slug", value: match object
	for (const status of statuses) {
		if (!status.content) continue;

		const links = extractLinksFromHtml(status.content);
		for (const link of links) {
			const parsed = parseSiteUrl(link);
			if (parsed) {
				const key = `${parsed.type}/${parsed.slug}`;
				// Always overwrite to keep the earliest (last in reverse-chronological order)
				matchMap.set(key, {
					type: parsed.type,
					slug: parsed.slug,
					mastodonUrl: status.url,
					blogUrl: link,
				});
			}
		}
	}

	const matches = Array.from(matchMap.values()).filter((m) => updateSet.has(`${m.type}/${m.slug}`));
	log.verb(`found ${matches.length} Mastodon posts for files needing update`);

	let updated = 0;
	let skipped = 0;
	const details = [];

	for (const match of matches) {
		const filePath = findMarkdownFile(match.type, match.slug);
		if (!filePath) continue;

		const relativePath = path.relative(ROOT_DIR, filePath);
		const content = fs.readFileSync(filePath, "utf-8");

		// Check if file already has this exact mastodon URL (skip if same)
		const existingMatch = content.match(/^mastodon:\s*"([^"]+)"/m);
		if (existingMatch && existingMatch[1] === match.mastodonUrl) {
			skipped++;
			continue;
		}

		// Remove existing mastodon field if present (for --force)
		let newContent = content.replace(/^mastodon:\s*"[^"]+"\n/m, "");
		newContent = insertMastodonField(newContent, match.mastodonUrl);

		if (DRY_RUN) {
			details.push(`${relativePath} → ${match.mastodonUrl}`);
		} else {
			fs.writeFileSync(filePath, newContent);
			details.push(`${relativePath} → ${match.mastodonUrl}`);
		}
		updated++;
	}

	// Files that had no matching Mastodon post
	const notFound = filesToUpdate.length - updated - skipped;

	const parts = [];
	parts.push(DRY_RUN ? `would update ${updated}` : `updated ${updated}`);
	if (skipped > 0) {
		parts.push(`${skipped} already correct`);
	}
	parts.push(`${notFound} without match`);
	log.step("mastodon", parts.join(" · "));
	for (const detail of details) log.detail(detail);
}

main().catch((error) => {
	log.fail("mastodon", error.message);
	process.exit(1);
});
