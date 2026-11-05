/**
 * Orchestrates the publish flow for blog posts and raw notes.
 *
 * Usage: node scripts/publish.js <blog|raw> <push|update> [flags]
 *
 *   push:   ready (images → videos → og → r2) → stage → commit → push → CogSend
 *   update: ready (images → videos → og → r2) → stage → commit → push
 *
 * Flags:
 *   --dry-run          run ready, show what would be committed, then stop
 *   --no-social        skip the CogSend announcement, site still publishes (push only).
 *                      CogSend is also skipped when COGSEND_API_URL / COGSEND_API_KEY are unset.
 *   --verbose, -v      forward to all steps (banners, counts, low-signal detail)
 *   --quiet, -q        forward to all steps (errors only)
 *   anything else      forwarded to sync-cogsend (push only), e.g.
 *                      --skip-poll, --platforms=threads
 *
 * Staging is scoped to paths the pipeline actually touches:
 * content/blog, content/raw, public/img/og, _data/cache. Untracked media
 * files (images, videos) are gitignored and never appear in the change
 * list, so only markdown, OG images, and cache files get committed.
 */
import path from "path";
import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { log, elapsedSince, isVerbose } from "./lib/log.js";
import "../_config/site.js"; // loads .env

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const TYPE = process.argv[2];
const ACTION = process.argv[3];
const REST = process.argv.slice(4);

if (!["blog", "raw"].includes(TYPE) || !["push", "update"].includes(ACTION)) {
	console.error("Usage: node scripts/publish.js <blog|raw> <push|update> [--dry-run] [--no-social] [cogsend flags]");
	process.exit(1);
}

const DRY_RUN = REST.includes("--dry-run");
const SOCIAL_CONFIGURED = Boolean(process.env.COGSEND_API_URL && process.env.COGSEND_API_KEY);
const NO_SOCIAL = REST.includes("--no-social");
const FORWARD = REST.filter((arg) => arg !== "--dry-run" && arg !== "--no-social" && arg !== "--");
const LOG_FLAGS = FORWARD.filter((arg) => ["--verbose", "-v", "--quiet", "-q"].includes(arg));

const READY_SCRIPTS = [
	"scripts/optimize-images.js",
	"scripts/process-videos.js",
	"scripts/generate-og-images.js",
	"scripts/sync-r2-images.js",
];

// Paths this pipeline can legitimately change; everything else in the
// working tree is left unstaged.
const STAGE_PREFIXES = ["content/blog/", "content/raw/", "public/img/og/", "_data/cache/"];
const CONTENT_FILE_RE = /^content\/(blog|raw)\/([^/]+)\/index\.md$/;

/** Run git in the repo root, returning the spawnSync result. */
function git(args) {
	return spawnSync("git", args, { cwd: ROOT_DIR, encoding: "utf-8" });
}

/** Parse `git status --porcelain -z` into [{ status, path }]. */
function changedFiles() {
	// --untracked-files=all lists files inside untracked directories
	// individually, so slugs can be detected from new note folders.
	const result = git(["status", "--porcelain", "-z", "--untracked-files=all"]);
	if (result.status !== 0) {
		throw new Error(`git status failed: ${result.stderr.trim()}`);
	}
	const entries = (result.stdout || "").split("\0").filter(Boolean);
	const changes = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const status = entry.slice(0, 2);
		const filePath = entry.slice(3);
		// Renames/copies emit two NUL-separated fields: the first entry
		// carries the status and the destination path, the second is a
		// bare entry with the source path. For renames the source must
		// be staged as a deletion too, otherwise the rename commits as
		// an add-only (leaving the old file tracked).
		if (status.startsWith("R")) {
			i += 1;
			if (i < entries.length) {
				changes.push({ status: "A ", path: filePath });
				changes.push({ status: "D ", path: entries[i] });
			}
			continue;
		}
		if (status.startsWith("C")) {
			i += 1;
			if (i < entries.length) {
				changes.push({ status: "A ", path: filePath });
			}
			continue;
		}
		changes.push({ status, path: filePath });
	}
	return changes;
}

/** Run sync-cogsend as a child process, returning its exit code. */
function runCogsend(targetFile) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["scripts/sync-cogsend.js", targetFile, ...FORWARD], {
			cwd: ROOT_DIR,
			stdio: "inherit",
		});
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", (error) => {
			log.fail("cogsend", `failed to start: ${error.message}`);
			resolve(1);
		});
	});
}

async function main() {
	const start = Date.now();
	const preHash = git(["rev-parse", "--short", "HEAD"]).stdout.trim();

	if (DRY_RUN) {
		log.info("publish", "dry run — nothing will be committed or pushed");
	}

	// 1. ready: images → videos → og → r2
	for (const script of READY_SCRIPTS) {
		// In dry-run mode the R2 step must stay read-only; the other steps
		// only write local files (which is what the preview should show).
		const extra = DRY_RUN && script.endsWith("sync-r2-images.js") ? ["--dry-run"] : [];
		const result = spawnSync(process.execPath, [script, ...extra, ...LOG_FLAGS], {
			cwd: ROOT_DIR,
			stdio: "inherit",
		});
		if (result.status !== 0) {
			log.fail("publish", `${path.basename(script)} failed (exit ${result.status}) — aborting`);
			process.exit(result.status || 1);
		}
	}

	// 2. Figure out what changed under the pipeline paths
	const changes = changedFiles();
	const stageChanges = changes.filter((change) => STAGE_PREFIXES.some((prefix) => change.path.startsWith(prefix)));
	const contentFiles = changes
		.filter((change) => CONTENT_FILE_RE.test(change.path) && !change.status.includes("D"))
		.map((change) => change.path);

	if (stageChanges.length === 0) {
		log.info("publish", "nothing to commit — skipping commit, push, and CogSend sync");
		process.exit(0);
	}

	if (DRY_RUN) {
		log.info("publish", `${stageChanges.length} file(s) would be committed:`);
		for (const change of stageChanges) log.detail(change.path);
		process.exit(0);
	}

	// 3. Stage and commit
	const addResult = git(["add", "--", ...stageChanges.map((change) => change.path)]);
	if (addResult.status !== 0) {
		log.fail("publish", `git add failed: ${addResult.stderr.trim()}`);
		process.exit(1);
	}

	const slugs = [...new Set(contentFiles.map((file) => file.match(CONTENT_FILE_RE)?.[2]).filter(Boolean))];
	const slugPart = slugs.length > 0 ? slugs.join(", ") : "content";
	const subject =
		ACTION === "push" ? (TYPE === "blog" ? "new post" : "new note") : TYPE === "blog" ? "updated post" : "updated note";
	const message = `${subject}: ${slugPart}`;

	const commitResult = git(["commit", "-m", message]);
	if (commitResult.status !== 0) {
		log.fail("publish", `git commit failed: ${commitResult.stderr.trim().split("\n")[0]}`);
		process.exit(1);
	}
	const hash = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
	log.step("commit", `${hash} ${message} (${stageChanges.length} file${stageChanges.length === 1 ? "" : "s"})`);
	for (const change of stageChanges.slice(0, isVerbose ? stageChanges.length : 8)) {
		log.detail(change.path);
	}
	if (!isVerbose && stageChanges.length > 8) {
		log.detail(`… ${stageChanges.length - 8} more`);
	}

	// 4. Push
	const pushResult = git(["push", "-q", "origin", "HEAD"]);
	if (pushResult.status !== 0) {
		log.fail("publish", `git push failed: ${pushResult.stderr.trim()}`);
		process.exit(1);
	}
	log.step("push", `${preHash}..${hash} → origin`);

	// 5. CogSend (push only)
	if (ACTION === "push") {
		if (NO_SOCIAL) {
			log.info("publish", "skipping CogSend sync (--no-social)");
		} else if (!SOCIAL_CONFIGURED) {
			log.info("publish", "skipping CogSend sync (COGSEND_API_URL / COGSEND_API_KEY not set)");
		} else if (contentFiles.length === 0) {
			log.info("publish", "no content file in this commit — skipping CogSend sync");
		} else {
			const code = await runCogsend(contentFiles[0]);
			if (code !== 0) {
				log.fail(
					"publish",
					`CogSend sync failed (exit ${code}) — content is already pushed, re-run it manually if needed`,
				);
				process.exit(code);
			}
		}
	}

	log.step("publish", `done in ${elapsedSince(start)}`);
}

main().catch((error) => {
	log.fail("publish", error.message);
	process.exit(1);
});
