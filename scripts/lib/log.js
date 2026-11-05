/**
 * Shared console logging for scripts.
 *
 * Produces aligned one-line step summaries, plus indented detail lines
 * for files a step actually changed:
 *
 *   ✔ images   12 unchanged (0.4s)
 *   ✔ og       generated 1 · 40 unchanged (1.3s)
 *     ✔ raw/my-new-note/og.jpeg
 *
 * Conventions:
 *   - A script prints exactly one step line on success (log.step), and
 *     one log.detail line per file it changed. Low-signal output
 *     (banners, scan counts, font info) goes through log.verb and only
 *     shows with --verbose.
 *   - Errors go to stderr and are never suppressed.
 *   - Colors are stripped when stdout is not a TTY (CI, piped output) or
 *     when NO_COLOR is set.
 *
 * Flags supported by every script that imports this module:
 *   --quiet, -q    suppress everything except errors
 *   --verbose, -v  show banners, counts, and other detail
 */

const args = process.argv.slice(2);

export const isQuiet = args.includes("--quiet") || args.includes("-q") || process.env.LOG_LEVEL === "quiet";
export const isVerbose = args.includes("--verbose") || args.includes("-v") || process.env.LOG_LEVEL === "verbose";

const noColor = "NO_COLOR" in process.env && process.env.NO_COLOR !== "0";
const useColor = Boolean(process.stdout.isTTY) && !noColor;

const ANSI = { dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };

function paint(color, text) {
	return useColor ? `\x1b[${ANSI[color]}m${text}\x1b[0m` : text;
}

/** `${sign} ${label}${pad} ${detail}`, e.g. `✔ images   391 unchanged`. */
function emit(stream, sign, color, label, detail = "") {
	const line = `${paint(color, sign)} ${label.padEnd(9)} ${detail}`.trimEnd();
	stream.write(line + "\n");
}

export const log = {
	/** Summary line for a completed step. Print exactly one per script run. */
	step(label, detail = "") {
		if (!isQuiet) emit(process.stdout, "✔", "green", label, detail);
	},

	/** Non-blocking info (modes, flags, progress). */
	info(label, detail = "") {
		if (!isQuiet) emit(process.stdout, "ℹ", "cyan", label, detail);
	},

	/** Warning: `⚠ og  font download failed, using system fonts`. */
	warn(label, detail = "") {
		if (!isQuiet) emit(process.stdout, "⚠", "yellow", label, detail);
	},

	/** Error line on stderr. Never suppressed. */
	fail(label, detail = "") {
		emit(process.stderr, "✖", "red", label, detail);
	},

	/** A file the step changed: `  ✔ content/raw/x/og.jpeg`. */
	detail(message) {
		if (!isQuiet) process.stdout.write(`  ${paint("green", "✔")} ${message}\n`);
	},

	/** Error tied to a specific file: `  ✖ upload failed`. */
	failDetail(message) {
		process.stderr.write(`  ${paint("red", "✖")} ${message}\n`);
	},

	/** Verbose-only line. */
	verb(message) {
		if (!isQuiet && isVerbose) process.stdout.write(paint("dim", message) + "\n");
	},

	/** Verbose-only section banner: `── og ──`. */
	banner(label) {
		if (!isQuiet && isVerbose) process.stdout.write(`\n${paint("dim", `── ${label} ──`)}\n`);
	},

	/** Pluralize: `log.count(3, "file")` → "3 files", `log.count(1, "file")` → "1 file". */
	count(n, word, plural = `${word}s`) {
		return `${n} ${n === 1 ? word : plural}`;
	},
};

/** Seconds since a `Date.now()` start, formatted like `(1.4s)`. */
export function elapsedSince(start) {
	return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}
