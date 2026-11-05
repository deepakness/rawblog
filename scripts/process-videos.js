/**
 * Process co-located videos for blog/raw notes.
 *
 * For every .mov/.mp4 dropped into a note folder, this script:
 *   1. Transcodes it to an optimized, web-ready H.264 MP4 (+faststart,
 *      yuv420p, scaled down if wider than maxWidth, loudnorm when audio
 *      exists).
 *   2. Generates <base>-poster.webp (a frame from ~25% into the video)
 *      unless a poster file already exists.
 *   3. Records hashes/dimensions in _data/cache/video-cache.json so
 *      unchanged inputs are skipped on the next run.
 *
 * Usage: node scripts/process-videos.js [--force]
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { log, elapsedSince } from "./lib/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT_DIR, "_data", "cache", "video-cache.json");

const FORCE = process.argv.includes("--force");

const CONFIG = {
	extensions: [".mp4", ".mov"],
	crf: 26,
	preset: "slow",
	maxWidth: 1600,
	posterTimeFraction: 0.25,
	posterQuality: 80,
	audioNormalize: "loudnorm=I=-17:TP=-1.5:LRA=11",
};

const FFMPEG_QUIET = ["-hide_banner", "-nostats", "-loglevel", "error"];

function loadCache() {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function saveCache(cache) {
	fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, "\t"));
}

function getFileHash(filePath) {
	const content = fs.readFileSync(filePath);
	return crypto.createHash("md5").update(content).digest("hex");
}

/** Run a command, returning { ok, stdout, stderr, error }. */
function run(command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		// spawnSync's 1MB default kills the child (status null) if output grows past it.
		maxBuffer: 32 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		stdout: (result.stdout || "").trim(),
		stderr: (result.stderr || "").trim(),
		error: result.error || null,
	};
}

function spawnFailText(result) {
	if (result.error) {
		const code = result.error.code ? ` (${result.error.code})` : "";
		return `${result.error.message}${code}`;
	}
	return result.stderr.slice(-400);
}

function requireBin(bin) {
	const probe = run(bin, ["-version"]);
	if (!probe.ok) {
		log.fail("videos", `"${bin}" not found — install it to process videos`);
		process.exit(1);
	}
}

/** { width, height, duration, hasAudio } or null when not a video. */
function probeVideo(filePath) {
	const info = run("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height",
		"-of",
		"csv=p=0",
		filePath,
	]);
	if (!info.ok || !info.stdout) {
		return null;
	}

	const [widthStr, heightStr] = info.stdout.split(",");
	const durationInfo = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath]);
	const duration = durationInfo.ok && durationInfo.stdout ? parseFloat(durationInfo.stdout) : 0;

	const audioInfo = run("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"a",
		"-show_entries",
		"stream=codec_name",
		"-of",
		"csv=p=0",
		filePath,
	]);

	return {
		width: parseInt(widthStr, 10),
		height: parseInt(heightStr, 10),
		duration,
		hasAudio: audioInfo.ok && audioInfo.stdout.length > 0,
	};
}

/**
 * Cap width at maxWidth and force an even width (yuv420p requirement);
 * height follows aspect ratio (-2). Videos already at or under maxWidth
 * pass through untouched apart from rounding odd widths down by one.
 */
function scaleFilter(maxWidth) {
	return `scale='trunc(min(${maxWidth},iw)/2)*2':-2:flags=lanczos`;
}

/** Transcode to optimized MP4, writing via a temp file, then rename. */
function transcode(inputPath, outputPath, probe) {
	const tempPath = `${outputPath}.tmp.mp4`;
	if (fs.existsSync(tempPath)) {
		fs.unlinkSync(tempPath);
	}

	const args = [
		...FFMPEG_QUIET,
		"-y",
		"-i",
		inputPath,
		"-vf",
		scaleFilter(CONFIG.maxWidth),
		"-c:v",
		"libx264",
		"-preset",
		CONFIG.preset,
		"-crf",
		String(CONFIG.crf),
		"-pix_fmt",
		"yuv420p",
		"-profile:v",
		"main",
	];

	if (probe.hasAudio) {
		args.push("-c:a", "aac", "-b:a", "96k", "-af", CONFIG.audioNormalize);
	} else {
		args.push("-an");
	}

	args.push("-movflags", "+faststart", tempPath);

	const result = run("ffmpeg", args);
	if (!result.ok) {
		log.failDetail(`ffmpeg failed: ${spawnFailText(result)}`);
		if (fs.existsSync(tempPath)) {
			fs.unlinkSync(tempPath);
		}
		return null;
	}

	fs.renameSync(tempPath, outputPath);
	return outputPath;
}

// Some ffmpeg builds ship without a webp encoder (Homebrew ffmpeg 9+).
// The check is cached; cwebp is the fallback poster encoder.
let ffmpegWebpSupport = null;

function ffmpegCanEncodeWebp() {
	if (ffmpegWebpSupport !== null) {
		return ffmpegWebpSupport;
	}

	const result = run("ffmpeg", ["-hide_banner", "-encoders"]);
	if (!result.ok) {
		ffmpegWebpSupport = false;
		return false;
	}

	ffmpegWebpSupport = result.stdout.split("\n").some((line) => {
		const match = line.trim().match(/^[VASF.]{6}\s+(\S+)/);
		return match && (match[1] === "webp" || match[1] === "libwebp");
	});
	return ffmpegWebpSupport;
}

function hasBin(bin) {
	return run(bin, ["-version"]).ok;
}

/**
 * Fallback poster path for ffmpeg builds without webp encoding. Extract
 * one PNG frame with ffmpeg, then convert it with cwebp.
 */
function generatePosterWithCwebp(videoPath, posterPath, posterTime) {
	const tmpPng = `${posterPath}.tmp.png`;

	const frame = run("ffmpeg", [
		...FFMPEG_QUIET,
		"-y",
		"-ss",
		posterTime.toFixed(2),
		"-i",
		videoPath,
		"-frames:v",
		"1",
		tmpPng,
	]);
	if (!frame.ok) {
		log.failDetail(`poster frame extraction failed: ${spawnFailText(frame)}`);
		if (fs.existsSync(tmpPng)) {
			fs.unlinkSync(tmpPng);
		}
		return false;
	}

	if (!hasBin("cwebp")) {
		log.failDetail(
			'ffmpeg has no webp encoder and "cwebp" is not installed — install the webp tools (brew install webp) to generate posters',
		);
		if (fs.existsSync(tmpPng)) {
			fs.unlinkSync(tmpPng);
		}
		return false;
	}

	const convert = run("cwebp", ["-quiet", "-q", String(CONFIG.posterQuality), tmpPng, "-o", posterPath]);
	if (fs.existsSync(tmpPng)) {
		fs.unlinkSync(tmpPng);
	}

	if (!convert.ok) {
		log.failDetail(`cwebp conversion failed: ${spawnFailText(convert)}`);
		if (fs.existsSync(posterPath)) {
			fs.unlinkSync(posterPath);
		}
		return false;
	}

	return true;
}

/** Generate <base>-poster.webp from the optimized video, unless it exists. */
function ensurePoster(videoPath, posterPath, probe) {
	if (fs.existsSync(posterPath)) {
		return { generated: false };
	}

	const posterTime = Math.max(0.1, (probe.duration || 1) * CONFIG.posterTimeFraction);

	if (ffmpegCanEncodeWebp()) {
		const result = run("ffmpeg", [
			...FFMPEG_QUIET,
			"-y",
			"-ss",
			posterTime.toFixed(2),
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-q:v",
			String(CONFIG.posterQuality),
			posterPath,
		]);

		if (result.ok) {
			return { generated: true };
		}

		// Encoder selection can still fail for other reasons; drop any
		// partial file and try the cwebp path below.
		if (fs.existsSync(posterPath)) {
			fs.unlinkSync(posterPath);
		}
	}

	if (generatePosterWithCwebp(videoPath, posterPath, posterTime)) {
		return { generated: true };
	}

	return { generated: false, failed: true };
}

function findVideos() {
	const videos = [];
	const contentDirs = [path.join(ROOT_DIR, "content", "blog"), path.join(ROOT_DIR, "content", "raw")];

	for (const contentDir of contentDirs) {
		if (!fs.existsSync(contentDir)) {
			continue;
		}

		const postDirs = fs
			.readdirSync(contentDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(contentDir, entry.name));

		for (const postDir of postDirs) {
			for (const file of fs.readdirSync(postDir)) {
				const ext = path.extname(file).toLowerCase();
				if (!CONFIG.extensions.includes(ext) || file.startsWith(".")) {
					continue;
				}

				// A .mp4 next to a same-named .mov is the pipeline's own output;
				// the .mov is the source of truth. Skipping it here keeps the
				// pipeline from re-encoding its own output on every run.
				const base = path.basename(file, ext);
				if (ext === ".mp4" && fs.existsSync(path.join(postDir, `${base}.mov`))) {
					continue;
				}

				videos.push(path.join(postDir, file));
			}
		}
	}

	return videos.sort((a, b) => a.localeCompare(b));
}

function formatSize(bytes) {
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function main() {
	const start = Date.now();
	log.banner("videos");

	const videos = findVideos();
	if (videos.length === 0) {
		log.verb("no videos found");
		return;
	}

	// Only needed when there is something to process, so sites without
	// videos never need ffmpeg installed.
	requireBin("ffmpeg");
	requireBin("ffprobe");

	const cache = loadCache();
	const nextCache = { ...cache };

	log.verb(`checking ${videos.length} video file(s)`);

	let processed = 0;
	let skipped = 0;
	let failed = 0;
	let postersGenerated = 0;
	const details = [];

	for (const inputPath of videos) {
		const relativePath = path.relative(ROOT_DIR, inputPath).split(path.sep).join("/");
		const inputHash = getFileHash(inputPath);
		const inputSize = fs.statSync(inputPath).size;
		const base = path.basename(inputPath, path.extname(inputPath));
		const outputPath = path.join(path.dirname(inputPath), `${base}.mp4`);
		const outputRel = path.relative(ROOT_DIR, outputPath).split(path.sep).join("/");
		const posterPath = path.join(path.dirname(inputPath), `${base}-poster.webp`);

		const cached = nextCache[outputRel];

		// Mirror the image pipeline: the skip check compares against the
		// hash of the file as it exists AFTER processing (outputHash), not
		// the pre-transcode input. For .mp4 inputs the output overwrites the
		// input in place, so comparing the stored input hash would
		// re-encode the file on every run.
		const currentOutputHash = fs.existsSync(outputPath) ? getFileHash(outputPath) : null;
		const inputExt = path.extname(inputPath).toLowerCase();
		const unchanged =
			!FORCE &&
			cached &&
			cached.source === path.basename(inputPath) &&
			cached.outputHash &&
			cached.outputHash === currentOutputHash &&
			(inputExt === ".mp4" ||
				// For .mov sources, also require the source recording itself
				// to be unchanged; a hand-edited output gets regenerated
				// from the authoritative .mov.
				(cached.inputHash === inputHash && fs.existsSync(outputPath)));

		if (unchanged) {
			skipped += 1;
			// Poster can be deleted independently; keep the guarantee that a
			// poster always exists without re-encoding.
			const poster = ensurePoster(outputPath, posterPath, { duration: cached.duration || 0 });
			if (poster.generated) {
				postersGenerated += 1;
				nextCache[outputRel] = { ...cached, poster: path.basename(posterPath) };
			}
			continue;
		}

		const probe = probeVideo(inputPath);
		if (!probe) {
			failed += 1;
			log.failDetail(`not a readable video: ${relativePath}`);
			continue;
		}

		log.info(
			"videos",
			`processing ${relativePath} (${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s, audio: ${probe.hasAudio ? "yes" : "no"})`,
		);

		const result = transcode(inputPath, outputPath, probe);
		if (!result) {
			failed += 1;
			log.failDetail(`transcode failed: ${relativePath}`);
			continue;
		}

		const outputSize = fs.statSync(outputPath).size;
		const poster = ensurePoster(outputPath, posterPath, probe);
		if (poster.failed) {
			failed += 1;
			log.failDetail(`poster failed: ${relativePath}`);
			continue;
		}
		if (poster.generated) {
			postersGenerated += 1;
		}

		const savings = inputSize > 0 ? ` (-${Math.round((1 - outputSize / inputSize) * 100)}%)` : "";

		processed += 1;
		details.push(`${path.basename(outputPath)}: ${formatSize(inputSize)} → ${formatSize(outputSize)}${savings}`);
		nextCache[outputRel] = {
			inputHash,
			outputHash: getFileHash(outputPath),
			source: path.basename(inputPath),
			processedAt: new Date().toISOString(),
			width: probe.width,
			height: probe.height,
			duration: probe.duration,
			inputSize,
			outputSize,
			poster: path.basename(posterPath),
		};
	}

	// Prune entries whose output video no longer exists.
	for (const key of Object.keys(nextCache)) {
		if (!nextCache[key].outputSize) {
			continue;
		}
		if (!fs.existsSync(path.join(ROOT_DIR, key))) {
			delete nextCache[key];
		}
	}

	saveCache(nextCache);

	const parts = [];
	if (processed > 0) parts.push(`processed ${processed}`);
	parts.push(`${skipped} unchanged`);
	if (postersGenerated > 0) parts.push(`posters ${postersGenerated}`);
	if (failed > 0) parts.push(`${failed} failed`);

	const summary = `${parts.join(" · ")} (${elapsedSince(start)})`;
	if (failed > 0) {
		log.warn("videos", summary);
	} else {
		log.step("videos", summary);
	}
	for (const detail of details) log.detail(detail);

	if (failed > 0) {
		process.exit(1);
	}
}

main();
