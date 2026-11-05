import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { log, isQuiet } from "./lib/log.js";
import site, { SITE_URL } from "../_config/site.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// Minutes after "now" a post is scheduled.
const SCHEDULE_IN_MINUTES = 15;

// Platform ids exactly as CogSend spells them in /api/connections.
const PLATFORM_IDS = ["x", "threads", "linkedin", "mastodon", "bluesky"];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_POLL = args.includes("--skip-poll");

// Unknown flags are rejected instead of being silently ignored.
const KNOWN_FLAGS = new Set(["--dry-run", "--skip-poll", "--verbose", "-v", "--quiet", "-q"]);
function rejectUnknownFlags() {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.endsWith(".md") && fs.existsSync(path.resolve(ROOT_DIR, arg))) continue;
		if (KNOWN_FLAGS.has(arg)) continue;
		if (arg.startsWith("--platforms=")) continue;
		if (arg === "--platforms" && args[i + 1] && !args[i + 1].startsWith("--")) {
			i++;
			continue;
		}
		log.fail("cogsend", `unsupported flag: ${arg} (this script always schedules ${SCHEDULE_IN_MINUTES}m out)`);
		process.exit(1);
	}
}

// Parse --platforms=threads,linkedin or --platforms threads,linkedin
function parsePlatformsArg() {
	const extraPlatforms = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--platforms=")) {
			const val = arg.split("=")[1];
			if (val) {
				extraPlatforms.push(...val.split(",").map((p) => p.trim().toLowerCase()));
			}
		} else if (arg === "--platforms" && args[i + 1] && !args[i + 1].startsWith("--")) {
			extraPlatforms.push(...args[i + 1].split(",").map((p) => p.trim().toLowerCase()));
		}
	}
	return extraPlatforms;
}

// Default platforms come from `cogsend.platforms` in site.config.js;
// --platforms= adds more on top for a single run.
function getEnabledPlatforms() {
	const extra = parsePlatformsArg();
	const unknown = extra.filter((p) => !PLATFORM_IDS.includes(p));
	if (unknown.length > 0) {
		log.fail("cogsend", `unknown platform(s): ${unknown.join(", ")} — known: ${PLATFORM_IDS.join(", ")}`);
		process.exit(1);
	}
	const defaultPlatforms = (site.cogsend?.platforms || []).map((p) => String(p).toLowerCase());
	const allPlatforms = new Set([...defaultPlatforms, ...extra].filter(Boolean));
	return Array.from(allPlatforms);
}

function getTargetFilePath() {
	for (const arg of args) {
		if (arg.endsWith(".md") && fs.existsSync(path.resolve(ROOT_DIR, arg))) {
			return path.resolve(ROOT_DIR, arg);
		}
	}

	try {
		const gitOutput = execSync('git show --name-only --format="" HEAD', {
			cwd: ROOT_DIR,
			encoding: "utf-8",
		});

		const changedFiles = gitOutput
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);

		// Match content/blog/<slug>/index.md or content/raw/<slug>/index.md
		const targetFile = changedFiles.find((f) => /^content\/(blog|raw)\/[^/]+\/index\.md$/.test(f));
		if (targetFile) {
			return path.resolve(ROOT_DIR, targetFile);
		}
	} catch (err) {
		log.warn("cogsend", `git query failed: ${err.message}`);
	}

	return null;
}

function parseFrontmatter(content) {
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	if (!match) return { attributes: {}, body: content };

	const yamlBlock = match[1];
	const body = content.slice(match[0].length).trim();
	const attributes = {};

	const lines = yamlBlock.split("\n");
	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim();
			let value = line.slice(colonIndex + 1).trim();

			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			attributes[key] = value;
		}
	}

	return { attributes, body };
}

async function pollLiveUrl(url, maxAttempts = 40, delayMs = 3000) {
	const interactive = Boolean(process.stdout.isTTY) && !isQuiet;
	const maxSeconds = Math.round((maxAttempts * delayMs) / 1000);
	log.info("cogsend", `waiting for deploy — polling ${url} (up to ${maxSeconds}s)`);
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (interactive) {
			process.stdout.write(`\r  waiting for deploy… ${attempt}/${maxAttempts}`);
		} else if (attempt % 10 === 0) {
			log.verb(`poll attempt ${attempt}/${maxAttempts}`);
		}
		try {
			const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
			if (response.ok) {
				if (interactive) process.stdout.write("\r\x1b[2K");
				log.detail(`live page confirmed (${Math.round((attempt * delayMs) / 1000)}s)`);
				return true;
			}
		} catch {
			// not live yet — keep polling
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}
	if (interactive) process.stdout.write("\r\x1b[2K");
	log.warn("cogsend", `poll timed out after ${maxSeconds}s — scheduling anyway`);
	return false;
}

async function api(apiUrl, apiKey, method, apiPath, body) {
	const response = await fetch(`${apiUrl}${apiPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			// Required: the API is a SvelteKit app whose built-in CSRF guard
			// rejects form-encoded POSTs without an Origin header (403).
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`API error (${response.status}) on ${method} ${apiPath}: ${errText.slice(0, 300)}`);
	}
	return response.json();
}

async function main() {
	rejectUnknownFlags();

	const apiUrl = (process.env.COGSEND_API_URL || "").replace(/\/$/, "");
	const apiKey = process.env.COGSEND_API_KEY;
	if (!apiUrl) {
		log.fail("cogsend", "COGSEND_API_URL is not set in .env (your CogSend instance URL)");
		process.exit(1);
	}
	if (!apiKey) {
		log.fail(
			"cogsend",
			"COGSEND_API_KEY is not set in .env (needs a Read + write key from CogSend Settings → API access)",
		);
		process.exit(1);
	}

	const filePath = getTargetFilePath();
	if (!filePath) {
		log.info("cogsend", "nothing to sync — no blog/raw content in latest commit");
		process.exit(0);
	}

	const relativePath = path.relative(ROOT_DIR, filePath);
	log.verb(`target: ${relativePath}`);

	// Determine post type and slug from path (content/blog/slug/index.md or content/raw/slug/index.md)
	const pathParts = relativePath.split(path.sep);
	const contentType = pathParts[1]; // 'blog' or 'raw'
	const slug = pathParts[2];

	if (!contentType || !slug || !["blog", "raw"].includes(contentType)) {
		log.fail("cogsend", `invalid content path structure: ${relativePath}`);
		process.exit(1);
	}

	const fileContent = fs.readFileSync(filePath, "utf-8");
	const { attributes } = parseFrontmatter(fileContent);

	const title = attributes.title || slug;
	const description = attributes.description || "";
	const liveUrl = `${SITE_URL}/${contentType}/${slug}/`;

	const labels = site.cogsend?.labels || {};
	const prefix = (contentType === "blog" ? labels.blog : labels.raw) || "";
	const heading = prefix ? `${prefix} ${title}` : title;
	const postText = [heading, description, liveUrl].filter(Boolean).join("\n\n");

	const enabledPlatforms = getEnabledPlatforms();
	log.info("cogsend", `platforms: ${enabledPlatforms.join(", ")}`);

	if (DRY_RUN) {
		// Fully offline: no connections lookup, no poll,
		// nothing sent. Connection ids resolve at send time.
		const runAt = new Date(Date.now() + SCHEDULE_IN_MINUTES * 60 * 1000).toISOString();
		log.info("cogsend", "dry run — requests that would be sent to the CogSend API:");
		console.log(
			JSON.stringify(
				{
					"POST /api/drafts": { title, baseBody: postText },
					"POST /api/drafts/:id/schedule": { platforms: enabledPlatforms, runAt },
				},
				null,
				2,
			),
		);
		process.exit(0);
	}

	// Resolve platform names to CogSend connection ids (active accounts only).
	// Multiple active accounts on one platform all get the post, with a
	// warning so an added account can never silently join announcements.
	const connRes = await api(apiUrl, apiKey, "GET", "/api/connections").catch((err) => {
		log.fail("cogsend", `could not list connections: ${err.message}`);
		process.exit(1);
	});
	const connectionIds = [];
	for (const platform of enabledPlatforms) {
		const accounts = (connRes.connections || []).filter((c) => (c.platform || "").toLowerCase() === platform);
		const matches = accounts.filter((c) => c.status === "active");
		if (matches.length === 0) {
			const inactive = accounts.map((c) => `${c.handle || c.displayName || c.id} (${c.status})`);
			log.fail(
				"cogsend",
				inactive.length > 0
					? `no active ${platform} account in CogSend — ${inactive.join(", ")}; reconnect it or drop the platform`
					: `no ${platform} account connected in CogSend — connect it first or drop the platform`,
			);
			process.exit(1);
		}
		if (matches.length > 1) {
			log.warn(
				"cogsend",
				`${matches.length} active ${platform} accounts — posting to all: ${matches.map((c) => c.displayName || c.handle || c.id).join(", ")}`,
			);
		}
		connectionIds.push(...matches.map((c) => c.id));
	}

	// Scheduling time is evaluated after polling completes
	const scheduleRun = async () => {
		const runAt = new Date(Date.now() + SCHEDULE_IN_MINUTES * 60 * 1000).toISOString();
		const created = await api(apiUrl, apiKey, "POST", "/api/drafts", { title, baseBody: postText });
		const draftId = created.draft?.id;
		if (!draftId) throw new Error("draft creation returned no id");
		let scheduled;
		try {
			scheduled = await api(apiUrl, apiKey, "POST", `/api/drafts/${draftId}/schedule`, { connectionIds, runAt });
		} catch (err) {
			// Don't leave an orphan draft behind on scheduling failure: it
			// would sit in /posts looking like an unsent announcement.
			await api(apiUrl, apiKey, "DELETE", `/api/drafts/${draftId}`).catch(() => {});
			throw err;
		}
		const count = (scheduled.targets || []).length;
		log.step(
			"cogsend",
			`draft #${draftId} · ${enabledPlatforms.join(", ")} · ${SCHEDULE_IN_MINUTES}m from now (${runAt}) · ${count} target${count === 1 ? "" : "s"}`,
		);
		log.detail(`"${title}"`);
	};

	if (!SKIP_POLL) {
		await pollLiveUrl(liveUrl);
	}

	await scheduleRun();
}

main().catch((err) => {
	log.fail("cogsend", err.message);
	process.exit(1);
});
