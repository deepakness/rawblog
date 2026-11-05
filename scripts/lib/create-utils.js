/**
 * Shared helpers for content scaffolding scripts (blog, raw, bookmarks, changelog).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { siteNow } from "../../_config/time.js";

export const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Lowercase kebab-case slug: my-new-post */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Frontmatter datetime: `yyyy-MM-dd HH:mm:ss.SSS+00:00` in the site timezone */
export function formatSiteDateTime(dt = siteNow()) {
	return dt.toFormat("yyyy-MM-dd HH:mm:ss.SSSZZ");
}

/** Calendar day in the site timezone: `yyyy-MM-dd` */
export function formatSiteDate(dt = siteNow()) {
	return dt.toFormat("yyyy-MM-dd");
}

export function assertValidSlug(slug) {
	if (!SLUG_PATTERN.test(slug)) {
		console.error(`Invalid slug: "${slug}"`);
		console.error("Slug must match: lowercase letters, numbers, and single hyphens between words (e.g. my-new-post)");
		process.exit(1);
	}
}

/**
 * @param {string | undefined} slug
 * @param {{ example: string, label?: string }} opts
 */
export function requireSlug(slug, { example, label = "post" }) {
	if (!slug) {
		console.error(`Please provide a slug for the ${label}`);
		console.error(`Example: ${example}`);
		process.exit(1);
	}
	assertValidSlug(slug);
	return slug;
}

/** Title Case From Slug */
const TITLE_ACRONYMS = new Map([
	["ai", "AI"],
	["api", "API"],
	["cli", "CLI"],
	["css", "CSS"],
	["gpt", "GPT"],
	["html", "HTML"],
	["js", "JS"],
	["llm", "LLM"],
	["mcp", "MCP"],
	["og", "OG"],
	["pdf", "PDF"],
	["rss", "RSS"],
	["seo", "SEO"],
	["ui", "UI"],
	["ux", "UX"],
	["url", "URL"],
	["urls", "URLs"],
]);

export function titleCaseFromSlug(slug) {
	return slug
		.split("-")
		.map((word) => TITLE_ACRONYMS.get(word) || word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** Sentence case from slug: capitalize first letter of the first word only */
export function sentenceCaseFromSlug(slug) {
	return slug.charAt(0).toUpperCase() + slug.slice(1).split("-").join(" ");
}

/**
 * Open a file in $VISUAL / $EDITOR. Falls back to VS Code (`code`) on macOS,
 * and otherwise just leaves the printed path for you to open.
 */
export function openInEditor(filePath) {
	const absolutePath = path.resolve(filePath);
	const editor = process.env.VISUAL || process.env.EDITOR;

	const run = (command, args) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", () => {
			console.log(`Open it with your editor: ${absolutePath}`);
		});
	};

	if (editor) {
		const [command, ...args] = editor.split(/\s+/);
		run(command, [...args, absolutePath]);
		return;
	}

	if (process.platform === "darwin") {
		run("code", ["--goto", absolutePath]);
		return;
	}

	console.log(`Open it with your editor: ${absolutePath}`);
}

/**
 * Create content/<type>/<slug>/index.md if it does not exist.
 * @param {{
 *   type: "blog" | "raw",
 *   slug: string,
 *   title: string,
 *   description: string,
 *   body: string,
 *   successLabel: string,
 * }} opts
 */
export function createSlugIndexEntry({ type, slug, title, description, body, successLabel }) {
	const postDir = path.join(rootDir, "content", type, slug);
	const indexFile = path.join(postDir, "index.md");

	if (fs.existsSync(indexFile)) {
		console.error(`Error: A post with slug "${slug}" already exists at ${indexFile}`);
		process.exit(1);
	}

	fs.mkdirSync(postDir, { recursive: true });

	const content = `---
title: "${title}"
description: "${description}"
date: ${formatSiteDateTime()}
affiliate: false
tags:
- 
---

${body}
`;

	fs.writeFileSync(indexFile, content);
	console.log(`✨ ${successLabel} created successfully at: ${indexFile}`);
	console.log("Opening the file...");
	openInEditor(indexFile);
}
