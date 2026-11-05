import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { log, elapsedSince } from "./lib/log.js";
import "../_config/site.js"; // loads .env

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT_DIR, "_data", "cache", "r2-sync-cache.json");

const FLAGS = new Set(process.argv.slice(2));
const DRY_RUN = FLAGS.has("--dry-run");
const BOOTSTRAP = FLAGS.has("--bootstrap");

const CONFIG = {
	scanDirs: [path.join(ROOT_DIR, "content", "blog"), path.join(ROOT_DIR, "content", "raw")],
	imageExtensions: new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".mp4"]),
	cacheControl: "public, max-age=604800",
};

const MIME_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".gif": "image/gif",
	".mp4": "video/mp4",
};

const REQUIRED_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

function normalizePath(filePath) {
	return filePath.split(path.sep).join("/");
}

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
	const buffer = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getContentType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_TYPES[ext] || "application/octet-stream";
}

function isImageFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return CONFIG.imageExtensions.has(ext);
}

function collectFilesRecursively(dirPath) {
	const output = [];
	const stack = [dirPath];

	while (stack.length > 0) {
		const current = stack.pop();
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile() && isImageFile(fullPath)) {
				output.push(fullPath);
			}
		}
	}

	return output;
}

function getScopedImageFiles() {
	const files = [];

	for (const scanDir of CONFIG.scanDirs) {
		if (!fs.existsSync(scanDir)) {
			continue;
		}

		const entries = fs.readdirSync(scanDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const postDir = path.join(scanDir, entry.name);
			files.push(...collectFilesRecursively(postDir));
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

function toR2Key(relativePath) {
	if (!relativePath.startsWith("content/blog/") && !relativePath.startsWith("content/raw/")) {
		return null;
	}
	return relativePath.replace(/^content\//, "");
}

function getMissingEnvVars() {
	return REQUIRED_ENV.filter((name) => !process.env[name]);
}

function createR2Client() {
	return new S3Client({
		region: "auto",
		endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
		},
	});
}

async function uploadToR2(client, filePath, r2Key) {
	const command = new PutObjectCommand({
		Bucket: process.env.R2_BUCKET,
		Key: r2Key,
		Body: fs.createReadStream(filePath),
		ContentType: getContentType(filePath),
		CacheControl: CONFIG.cacheControl,
	});

	await client.send(command);
}

/** Upload with one retry for transient network errors. */
async function uploadWithRetry(client, filePath, r2Key) {
	for (let attempt = 1; ; attempt++) {
		try {
			await uploadToR2(client, filePath, r2Key);
			return;
		} catch (error) {
			if (attempt >= 2) throw error;
			log.verb(`upload failed, retrying (${attempt + 1}/2): ${error.message}`);
			await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
		}
	}
}

async function main() {
	const start = Date.now();
	log.banner("r2");

	const missingEnv = getMissingEnvVars();
	if (missingEnv.length === REQUIRED_ENV.length) {
		log.info("r2", "skipped — R2 is not configured, media is served from the site itself");
		process.exit(0);
	}
	if (missingEnv.length > 0) {
		log.fail("r2", `missing env vars: ${missingEnv.join(", ")}`);
		process.exit(1);
	}

	if (BOOTSTRAP) {
		log.info("r2", "bootstrap mode — uploading all files (ignores cache)");
	}

	if (DRY_RUN) {
		log.info("r2", "dry run — no uploads or cache writes");
	}

	const client = createR2Client();
	const cache = loadCache();
	const nextCache = { ...cache };
	const files = getScopedImageFiles();
	const seenPaths = new Set();

	let uploaded = 0;
	let skipped = 0;
	let failed = 0;
	const details = [];

	log.verb(`checking ${files.length} image file(s)`);

	for (const filePath of files) {
		const relativePath = normalizePath(path.relative(ROOT_DIR, filePath));
		const r2Key = toR2Key(relativePath);

		if (!r2Key) {
			continue;
		}

		seenPaths.add(relativePath);

		const stats = fs.statSync(filePath);
		const hash = getFileHash(filePath);
		const cached = cache[relativePath];
		const unchanged =
			!BOOTSTRAP && cached && cached.hash === hash && cached.size === stats.size && cached.r2Key === r2Key;

		if (unchanged) {
			skipped += 1;
			nextCache[relativePath] = cached;
			continue;
		}

		if (DRY_RUN) {
			uploaded += 1;
			details.push(`${relativePath} → ${r2Key} (would upload)`);
			continue;
		}

		try {
			await uploadWithRetry(client, filePath, r2Key);
			uploaded += 1;
			nextCache[relativePath] = {
				hash,
				size: stats.size,
				r2Key,
				uploadedAt: new Date().toISOString(),
			};
			if (BOOTSTRAP) {
				if (uploaded % 100 === 0 || uploaded === files.length) {
					log.info("r2", `uploading ${uploaded}/${files.length}`);
				}
			} else {
				details.push(`${relativePath} → ${r2Key}`);
			}
		} catch (error) {
			failed += 1;
			log.failDetail(`${relativePath}: ${error.message}`);
		}
	}

	for (const cacheKey of Object.keys(nextCache)) {
		const isScoped = cacheKey.startsWith("content/blog/") || cacheKey.startsWith("content/raw/");
		if (isScoped && !seenPaths.has(cacheKey)) {
			delete nextCache[cacheKey];
		}
	}

	if (!DRY_RUN) {
		saveCache(nextCache);
	}

	const parts = [];
	if (uploaded > 0) parts.push(DRY_RUN ? `would upload ${uploaded}` : `uploaded ${uploaded}`);
	parts.push(`${skipped} unchanged`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (DRY_RUN) parts.push("dry run");

	const summary = `${parts.join(" · ")} (${elapsedSince(start)})`;
	if (failed > 0) {
		log.warn("r2", summary);
	} else {
		log.step("r2", summary);
	}
	for (const detail of details) log.detail(detail);

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((error) => {
	log.fail("r2", error.message);
	process.exit(1);
});
