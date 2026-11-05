/**
 * Pre-deploy sanity check.
 *
 *   pnpm check            warn about leftover placeholders and sample content
 *   pnpm check --strict   fail on them (run this before going live)
 *
 * Add patterns to BLOCKED for strings that must never be committed, such as
 * a private email or an old domain. Those always fail the check.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import site from "../site.config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

const BLOCKED = [];
const SKIP_EXT = /\.(png|jpe?g|webp|gif|avif|ico|mp4|mov|webm|woff2?|ttf|pdf)$/i;
const SKIP_FILES = new Set(["pnpm-lock.yaml", "scripts/check.js"]);

const SAMPLE_ENTRIES = [
	"content/blog/starting-a-vegetable-garden",
	"content/blog/a-weekend-in-the-mountains",
	"content/blog/notes-on-reading-more",
	"content/blog/draft-example",
	"content/raw/sourdough-starter-day-one",
	"content/raw/tomato-blight",
	"content/raw/terminal-shortcuts",
	"content/raw/trail-snacks",
	"content/raw/library-card",
	"content/raw/embedding-videos",
];

function repoFiles() {
	try {
		return execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf-8" })
			.split("\n")
			.filter(Boolean);
	} catch {
		console.error("check: not a git repository, run `git init` first");
		process.exit(1);
	}
}

const failures = [];
const warnings = [];

if (BLOCKED.length > 0) {
	for (const file of repoFiles()) {
		if (SKIP_EXT.test(file) || SKIP_FILES.has(file)) continue;
		const abs = path.join(ROOT, file);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
		fs.readFileSync(abs, "utf-8")
			.split("\n")
			.forEach((line, i) => {
				for (const re of BLOCKED) {
					if (re.test(line)) failures.push(`${file}:${i + 1}  blocked string ${re}`);
				}
			});
	}
}

const isExample = (value) => /example\.(com|org)/.test(value || "");
const placeholders = [
	["title", site.title === "Your Name"],
	["url", isExample(site.url)],
	["author.name", site.author?.name === "Your Name"],
	["author.email", isExample(site.author?.email)],
	["socials", (site.socials || []).some((s) => /your-username|your-handle/.test(s.url))],
	["ogImage.footerText", isExample(site.ogImage?.footerText)],
];
for (const [key, isPlaceholder] of placeholders) {
	if (isPlaceholder) warnings.push(`site.config.js  ${key} is still a placeholder`);
}

const samples = SAMPLE_ENTRIES.filter((dir) => fs.existsSync(path.join(ROOT, dir)));
if (samples.length > 0) {
	warnings.push(`${samples.length} sample post(s)/note(s) still present, e.g. ${samples[0]}`);
}

for (const warning of warnings) console.log(`⚠ ${warning}`);
for (const failure of failures) console.log(`✖ ${failure}`);

if (failures.length || (STRICT && warnings.length)) {
	console.log(`\ncheck failed: ${failures.length} blocked, ${warnings.length} warning(s)`);
	process.exit(1);
}
console.log(
	warnings.length
		? `\ncheck passed with ${warnings.length} warning(s). Run \`pnpm check --strict\` before going live.`
		: "check passed",
);
