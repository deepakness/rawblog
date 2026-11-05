import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { log, elapsedSince } from "./lib/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(ROOT_DIR, "content", "blog");
const CACHE_FILE = path.join(ROOT_DIR, "_data", "cache", "image-cache.json");

const CONFIG = {
	webp: { maxWidth: 1200, quality: 80 },
	original: { maxWidth: 1600 },
	extensions: [".jpg", ".jpeg", ".png"],
	skipFiles: ["og.jpeg", "og.jpg", "og.png"], // Skip OG images (already optimized)
};

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

function findImages() {
	const images = [];

	const CONTENT_DIRS = [path.join(ROOT_DIR, "content", "blog"), path.join(ROOT_DIR, "content", "raw")];

	for (const contentDir of CONTENT_DIRS) {
		if (!fs.existsSync(contentDir)) {
			log.warn("images", `directory not found: ${contentDir}`);
			continue;
		}

		const postDirs = fs
			.readdirSync(contentDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(contentDir, d.name));

		for (const postDir of postDirs) {
			const files = fs.readdirSync(postDir);
			for (const file of files) {
				const ext = path.extname(file).toLowerCase();
				const fileName = file.toLowerCase();
				if (CONFIG.extensions.includes(ext) && !file.endsWith(".webp") && !CONFIG.skipFiles.includes(fileName)) {
					images.push(path.join(postDir, file));
				}
			}
		}
	}

	return images;
}

async function optimizeImage(imagePath, cache) {
	const relativePath = path.relative(ROOT_DIR, imagePath);
	const hash = getFileHash(imagePath);

	if (cache[relativePath]?.hash === hash) {
		return { status: "skipped" };
	}

	const dir = path.dirname(imagePath);
	const ext = path.extname(imagePath);
	const basename = path.basename(imagePath, ext);
	const webpPath = path.join(dir, `${basename}.webp`);

	try {
		const image = sharp(imagePath);
		const metadata = await image.metadata();

		// Create WebP version (max 1200px, quality 80)
		let webpPipeline = sharp(imagePath);
		let finalWidth = metadata.width;
		let finalHeight = metadata.height;

		if (metadata.width > CONFIG.webp.maxWidth) {
			const ratio = CONFIG.webp.maxWidth / metadata.width;
			finalWidth = CONFIG.webp.maxWidth;
			finalHeight = Math.round(metadata.height * ratio);
			webpPipeline = webpPipeline.resize(CONFIG.webp.maxWidth);
		}
		await webpPipeline.webp({ quality: CONFIG.webp.quality }).toFile(webpPath);

		// Optimize original (max 1600px, keep format)
		if (metadata.width > CONFIG.original.maxWidth) {
			const tempPath = imagePath + ".tmp";
			await sharp(imagePath).resize(CONFIG.original.maxWidth).toFile(tempPath);
			fs.renameSync(tempPath, imagePath);
			const newMeta = await sharp(imagePath).metadata();
			finalWidth = newMeta.width;
			finalHeight = newMeta.height;
		}

		cache[relativePath] = {
			hash: getFileHash(imagePath), // Recalculate after optimization
			width: finalWidth,
			height: finalHeight,
			optimizedAt: new Date().toISOString(),
		};

		return { status: "optimized", detail: `${relativePath} (${finalWidth}x${finalHeight})` };
	} catch (error) {
		log.failDetail(`${relativePath}: ${error.message}`);
		return { status: "failed" };
	}
}

/**
 * Records dimensions for image formats this script does not convert.
 *
 * A .webp or .gif committed straight into a post is never an input here: the
 * webp output path is derived as `<basename>.webp`, so feeding a .webp through
 * optimizeImage would make it read and overwrite itself. They are skipped, and
 * as a result they get no cache entry and no width/height in the HTML.
 *
 * That only shows up in production. Post images are gitignored and served from
 * R2, so a CI build has no file on disk to measure and the page ships an <img>
 * with no reserved space. The cache is committed, so writing the numbers here
 * is what carries them to the build.
 *
 * This measures only. It never re-encodes, resizes or writes an image.
 */
async function recordSourceDimensions(cache) {
	const MEASURE_ONLY = [".webp", ".gif", ".avif"];
	const CONTENT_DIRS = [path.join(ROOT_DIR, "content", "blog"), path.join(ROOT_DIR, "content", "raw")];

	let added = 0;
	for (const contentDir of CONTENT_DIRS) {
		if (!fs.existsSync(contentDir)) continue;
		const postDirs = fs
			.readdirSync(contentDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(contentDir, d.name));

		for (const postDir of postDirs) {
			for (const file of fs.readdirSync(postDir)) {
				const ext = path.extname(file).toLowerCase();
				if (!MEASURE_ONLY.includes(ext)) continue;
				if (CONFIG.skipFiles.includes(file.toLowerCase())) continue;

				// A sibling .webp generated from a .jpg/.png is already accounted for by
				// that source's cache entry; only hand-committed files need measuring.
				const base = path.basename(file, ext);
				const hasSource = CONFIG.extensions.some((e) => fs.existsSync(path.join(postDir, base + e)));
				if (hasSource) continue;

				const imagePath = path.join(postDir, file);
				const relativePath = path.relative(ROOT_DIR, imagePath);
				const hash = getFileHash(imagePath);
				if (cache[relativePath]?.hash === hash) continue;

				try {
					const { width, height } = await sharp(imagePath).metadata();
					if (!width || !height) continue;
					cache[relativePath] = { hash, width, height, measuredAt: new Date().toISOString() };
					added += 1;
				} catch (error) {
					log.failDetail(`${relativePath}: ${error.message}`);
				}
			}
		}
	}
	return added;
}

async function main() {
	const start = Date.now();
	log.banner("images");

	const cache = loadCache();
	const images = findImages();

	log.verb(`checking ${images.length} image file(s)`);

	let optimized = 0;
	let skipped = 0;
	let failed = 0;
	const details = [];

	const concurrency = Math.max(2, os.cpus().length);
	for (let i = 0; i < images.length; i += concurrency) {
		const chunk = images.slice(i, i + concurrency);
		const results = await Promise.all(chunk.map((imagePath) => optimizeImage(imagePath, cache)));
		for (const result of results) {
			if (result.status === "optimized") {
				optimized++;
				details.push(result.detail);
			} else if (result.status === "skipped") {
				skipped++;
			} else {
				failed++;
			}
		}
	}

	const measured = await recordSourceDimensions(cache);

	saveCache(cache);

	const parts = [];
	if (optimized > 0) parts.push(`optimized ${optimized}`);
	if (measured > 0) parts.push(`measured ${measured}`);
	parts.push(`${skipped} unchanged`);
	if (failed > 0) parts.push(`${failed} failed`);

	const summary = `${parts.join(" · ")} (${elapsedSince(start)})`;
	if (failed > 0) {
		log.warn("images", summary);
	} else {
		log.step("images", summary);
	}
	for (const detail of details) log.detail(detail);

	// Mirror process-videos.js: failures must stop publish.js before it commits,
	// otherwise a broken image ships with the post.
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((error) => {
	log.fail("images", error.message);
	process.exit(1);
});
