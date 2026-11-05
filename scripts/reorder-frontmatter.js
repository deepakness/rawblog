import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT_DIR, "content");

// Frontmatter keys are written in this order; unknown keys follow.
const STANDARD_KEY_ORDER = ["title", "description", "date", "updated", "image", "affiliate", "mastodon", "tags"];

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Reorder YAML frontmatter lines according to STANDARD_KEY_ORDER.
 * Preserves exact values, quotes, formatting, and body content.
 */
export function reorderFrontmatter(fileContent) {
	if (typeof fileContent !== "string" || !fileContent.startsWith("---")) return null;

	const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;

	const fmText = match[1];
	const bodyText = match[2];

	const lines = fmText.split(/\r?\n/);
	const fields = new Map(); // key -> array of line strings
	let currentKey = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (line.startsWith("- ") || line.startsWith("  - ")) {
			if (currentKey && fields.has(currentKey)) {
				fields.get(currentKey).push(line);
			}
		} else if (line.includes(":")) {
			const colonIdx = line.indexOf(":");
			const key = line.slice(0, colonIdx).trim();
			currentKey = key;
			if (!fields.has(key)) {
				fields.set(key, []);
			}
			fields.get(key).push(line);
		}
	}

	const reorderedLines = [];
	const processedKeys = new Set();

	for (const key of STANDARD_KEY_ORDER) {
		if (fields.has(key)) {
			reorderedLines.push(...fields.get(key));
			processedKeys.add(key);
		}
	}

	// Preserve any extra key not explicitly in standard order
	for (const [key, valLines] of fields.entries()) {
		if (!processedKeys.has(key)) {
			reorderedLines.push(...valLines);
		}
	}

	const newFm = "---\n" + reorderedLines.join("\n") + "\n---";
	const newContent = bodyText ? newFm + "\n\n" + bodyText : newFm + "\n";

	return {
		content: newContent,
		modified: newContent !== fileContent,
		keys: Array.from(fields.keys()),
		reorderedKeys: reorderedLines
			.filter((l) => l.includes(":") && !l.startsWith("-") && !l.startsWith("  -"))
			.map((l) => l.split(":")[0].trim()),
	};
}

function getAllMarkdownFiles(dir) {
	const results = [];
	if (!fs.existsSync(dir)) return results;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...getAllMarkdownFiles(fullPath));
		} else if (entry.name.endsWith(".md")) {
			results.push(fullPath);
		}
	}
	return results;
}

function main() {
	console.log("\n🔄 Frontmatter Reordering Script\n");
	if (DRY_RUN) {
		console.log("🔍 DRY RUN MODE - No files will be modified\n");
	}

	const blogFiles = getAllMarkdownFiles(path.join(CONTENT_DIR, "blog"));
	const rawFiles = getAllMarkdownFiles(path.join(CONTENT_DIR, "raw"));
	const allFiles = [...blogFiles, ...rawFiles];

	console.log(`Found ${allFiles.length} markdown files (${blogFiles.length} blog, ${rawFiles.length} raw).\n`);

	let modifiedCount = 0;
	let errorCount = 0;

	for (const filePath of allFiles) {
		const relPath = path.relative(ROOT_DIR, filePath);
		const originalContent = fs.readFileSync(filePath, "utf-8");
		const result = reorderFrontmatter(originalContent);

		if (!result) {
			console.error(`❌ Failed to parse frontmatter in: ${relPath}`);
			errorCount++;
			continue;
		}

		if (result.modified) {
			modifiedCount++;
			if (DRY_RUN) {
				console.log(`📝 Would reorder: ${relPath}`);
				console.log(`   Old order: [${result.keys.join(", ")}]`);
				console.log(`   New order: [${result.reorderedKeys.join(", ")}]`);
			} else {
				fs.writeFileSync(filePath, result.content, "utf-8");
				console.log(`✅ Reordered: ${relPath}`);
			}
		}
	}

	console.log("\n✨ Reordering Summary:");
	console.log(`   Total files checked: ${allFiles.length}`);
	console.log(`   Files reordered:     ${modifiedCount}`);
	console.log(`   Already matching:    ${allFiles.length - modifiedCount}`);
	console.log(`   Errors:              ${errorCount}\n`);
}

main();
