/**
 * Generate OG Images using Satori
 * This script generates 1200x630 JPEG images:
 * - Co-located with blog posts and raw notes (og.jpeg in post folder)
 * - In public/img/og/ for standalone pages ([slug].jpeg)
 * Skips posts/pages that already have og.png, og.jpeg, or og.jpg
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import crypto from "crypto";
import { log, elapsedSince } from "./lib/log.js";
import site, { SITE_HOST } from "../_config/site.js";
import { isDraftData } from "../_config/drafts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const CACHE_FILE = path.join(rootDir, "_data", "cache", "og-cache.json");
const BLOG_DIR = path.join(rootDir, "content", "blog");
const RAW_DIR = path.join(rootDir, "content", "raw");
const CONTENT_DIR = path.join(rootDir, "content");
const PAGES_OG_DIR = path.join(rootDir, "public", "img", "og");
const PHOTO_PATH = path.join(rootDir, site.ogImage?.photo || "public/img/avatar.png");
const OG_NAME = site.author?.name || site.title;
const OG_FOOTER_TEXT = site.ogImage?.footerText || SITE_HOST;
const SYSTEM_OG_FONT_FAMILY = "System Sans";
const OG_FONT_CACHE_DIR = path.join(rootDir, ".cache", "og-fonts");
const GOOGLE_OG_FONT = {
	family: "Bricolage Grotesque",
	files: {
		regular: {
			filename: "bricolage-grotesque-latin-400-normal.woff",
			url: "https://cdn.jsdelivr.net/npm/@fontsource/bricolage-grotesque@5.3.0/files/bricolage-grotesque-latin-400-normal.woff",
		},
		bold: {
			filename: "bricolage-grotesque-latin-700-normal.woff",
			url: "https://cdn.jsdelivr.net/npm/@fontsource/bricolage-grotesque@5.3.0/files/bricolage-grotesque-latin-700-normal.woff",
		},
	},
};

// Pages to skip (feeds, sitemaps, error pages, data files)
const SKIP_PAGES = [
	"index.njk", // Homepage handled separately
	"feed.md",
	"sitemap.xml.njk",
	"search-index-blog.njk",
	"search-index-raw.njk",
	"bookmarks-index.njk",
	"raw-notes.xml.njk",
	"404.njk",
];

// Homepage card: site title and description. A custom `image` in home.njk skips generation.
const HOMEPAGE = {
	slug: "home",
	title: site.title,
	description: site.description,
	layoutPath: path.join(rootDir, "_includes", "layouts", "home.njk"),
};

const photoBuffer = fs.readFileSync(PHOTO_PATH);
const photoMime = /\.jpe?g$/i.test(PHOTO_PATH) ? "image/jpeg" : "image/png";
const photoBase64 = `data:${photoMime};base64,${photoBuffer.toString("base64")}`;

// Fallback system fonts for Satori (used if Google Font loading fails)
function firstExistingPath(candidates) {
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function loadSystemOgFonts() {
	const regularCandidates = [
		// macOS
		"/System/Library/Fonts/Supplemental/Arial.ttf",
		"/System/Library/Fonts/SFNS.ttf",
		// Linux
		"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
		"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
	];

	const boldCandidates = [
		// macOS
		"/System/Library/Fonts/Supplemental/Arial Bold.ttf",
		// Linux
		"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
		"/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
	];

	const regularPath = firstExistingPath(regularCandidates);
	if (!regularPath) {
		throw new Error(`No usable system font found for OG image generation. Tried: ${regularCandidates.join(", ")}`);
	}

	const boldPath = firstExistingPath(boldCandidates) || regularPath;

	return {
		family: SYSTEM_OG_FONT_FAMILY,
		regularPath,
		boldPath,
		regularData: fs.readFileSync(regularPath),
		boldData: fs.readFileSync(boldPath),
	};
}

async function downloadGoogleOgFontFile(fontConfig) {
	const fontPath = path.join(OG_FONT_CACHE_DIR, fontConfig.filename);

	if (fs.existsSync(fontPath) && fs.statSync(fontPath).size > 0) {
		return fontPath;
	}

	fs.mkdirSync(OG_FONT_CACHE_DIR, { recursive: true });

	const response = await fetch(fontConfig.url, {
		signal: AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	const fontData = Buffer.from(await response.arrayBuffer());
	if (fontData.length === 0) {
		throw new Error("Downloaded font file is empty");
	}

	fs.writeFileSync(fontPath, fontData);
	return fontPath;
}

async function loadOgFonts() {
	try {
		const regularPath = await downloadGoogleOgFontFile(GOOGLE_OG_FONT.files.regular);
		const boldPath = await downloadGoogleOgFontFile(GOOGLE_OG_FONT.files.bold);

		return {
			family: GOOGLE_OG_FONT.family,
			source: "google",
			regularPath,
			boldPath,
			regularData: fs.readFileSync(regularPath),
			boldData: fs.readFileSync(boldPath),
		};
	} catch (error) {
		log.warn("og", `font download failed, using system fonts (${error.message})`);
		return {
			source: "system",
			...loadSystemOgFonts(),
		};
	}
}

function loadCache() {
	try {
		if (fs.existsSync(CACHE_FILE)) {
			return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
		}
	} catch (e) {
		log.verb("cache file not found or invalid, starting fresh");
	}
	return {};
}

function saveCache(cache) {
	fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, "\t"));
}

// Everything drawn on every card besides the title and description. It is part
// of each cache hash, so changing the name, footer text, or photo regenerates
// all images.
const BRAND_KEY = [OG_NAME, OG_FOOTER_TEXT, crypto.createHash("md5").update(photoBuffer).digest("hex")].join("|");

function generateHash(content) {
	return crypto.createHash("md5").update(`${BRAND_KEY}|${content}`).digest("hex");
}

function hasImageFrontmatter(frontmatter) {
	return frontmatter && frontmatter.image && frontmatter.image.length > 0;
}

// True when `image:` frontmatter points at the file this script auto-generates
// (e.g. /img/og/books.jpeg for pages, /blog/my-post/og.jpeg for posts). Such
// references are not custom images: a missing file must be regenerated, not skipped.
function isAutoOgReference(image, collection, slug) {
	if (!image || typeof image !== "string") return false;
	if (collection === "pages") {
		return image === `/img/og/${slug}.jpeg`;
	}
	return (
		image === `/${collection}/${slug}/og.jpeg` ||
		image === `/${collection}/${slug}/og.jpg` ||
		image === `/${collection}/${slug}/og.png`
	);
}

function parseFrontmatter(content) {
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return null;

	const frontmatter = {};
	const lines = match[1].split("\n");
	let currentKey = null;

	for (const line of lines) {
		if (line.startsWith("- ") && currentKey) {
			if (!Array.isArray(frontmatter[currentKey])) {
				frontmatter[currentKey] = [];
			}
			frontmatter[currentKey].push(line.slice(2).trim());
			continue;
		}

		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim();
			let value = line.slice(colonIndex + 1).trim();

			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			currentKey = key;
			frontmatter[key] = value || null;
		}
	}

	return frontmatter;
}

function getPosts(directory, collection) {
	const posts = [];

	if (!fs.existsSync(directory)) {
		return posts;
	}

	const items = fs.readdirSync(directory, { withFileTypes: true });

	for (const item of items) {
		if (item.isDirectory()) {
			const folderPath = path.join(directory, item.name);
			const indexPath = path.join(folderPath, "index.md");

			if (fs.existsSync(indexPath)) {
				const content = fs.readFileSync(indexPath, "utf-8");
				const frontmatter = parseFrontmatter(content);

				if (frontmatter && !isDraftData(frontmatter)) {
					posts.push({
						slug: item.name,
						folderPath,
						collection,
						title: frontmatter.title || item.name,
						description: frontmatter.description || "",
						hasCustomImage:
							hasImageFrontmatter(frontmatter) && !isAutoOgReference(frontmatter.image, collection, item.name),
						contentHash: generateHash(frontmatter.title + (frontmatter.description || "")),
					});
				}
			}
		}
	}

	return posts;
}

function getHomepage() {
	let hasCustomImage = false;
	if (fs.existsSync(HOMEPAGE.layoutPath)) {
		const content = fs.readFileSync(HOMEPAGE.layoutPath, "utf-8");
		const frontmatter = parseFrontmatter(content);
		hasCustomImage = hasImageFrontmatter(frontmatter) && !isAutoOgReference(frontmatter.image, "pages", HOMEPAGE.slug);
	}

	return {
		slug: HOMEPAGE.slug,
		filePath: HOMEPAGE.layoutPath,
		collection: "pages",
		title: HOMEPAGE.title,
		description: HOMEPAGE.description,
		hasCustomImage,
		contentHash: generateHash(HOMEPAGE.title + HOMEPAGE.description),
	};
}

function getPages() {
	const pages = [];

	if (!fs.existsSync(CONTENT_DIR)) {
		return pages;
	}

	const items = fs.readdirSync(CONTENT_DIR, { withFileTypes: true });

	for (const item of items) {
		if (!item.isFile()) continue;

		const fileName = item.name;

		if (SKIP_PAGES.includes(fileName)) continue;

		if (!fileName.endsWith(".njk") && !fileName.endsWith(".md")) continue;

		const filePath = path.join(CONTENT_DIR, fileName);
		const content = fs.readFileSync(filePath, "utf-8");
		const frontmatter = parseFrontmatter(content);

		if (!frontmatter || !frontmatter.title) continue;

		const slug = fileName.replace(/\.(njk|md)$/, "");

		pages.push({
			slug,
			filePath,
			collection: "pages",
			title: frontmatter.title,
			description: frontmatter.description || "",
			hasCustomImage: hasImageFrontmatter(frontmatter) && !isAutoOgReference(frontmatter.image, "pages", slug),
			contentHash: generateHash(frontmatter.title + (frontmatter.description || "")),
		});
	}

	return pages;
}

// Simple wireframe globe icon (circle + meridian + equator)

const accentColor = "#3364ff";

// Generate OG image SVG using Satori
async function generateOgSvg(title, description, ogFonts) {
	const displayTitle = title;
	const displayDesc = description;

	const svg = await satori(
		{
			type: "div",
			props: {
				style: {
					height: "100%",
					width: "100%",
					display: "flex",
					flexDirection: "column",
					backgroundColor: "#ffffff",
					fontFamily: ogFonts.family,
					position: "relative",
				},
				children: [
					// Background grid pattern overlay
					{
						type: "div",
						props: {
							style: {
								position: "absolute",
								top: 0,
								left: 0,
								right: 0,
								bottom: 0,
								opacity: 0.05,
								backgroundImage: `linear-gradient(to right, ${accentColor} 1px, transparent 1px), linear-gradient(to bottom, ${accentColor} 1px, transparent 1px)`,
								backgroundSize: "40px 40px",
							},
						},
					},
					// Blue accent bar at top
					{
						type: "div",
						props: {
							style: {
								width: "100%",
								height: "12px",
								backgroundColor: accentColor,
							},
						},
					},
					// Content area
					{
						type: "div",
						props: {
							style: {
								display: "flex",
								flexDirection: "column",
								justifyContent: "space-between",
								flex: 1,
								padding: "80px 128px",
							},
							children: [
								// Main content - Title and description centered
								{
									type: "div",
									props: {
										style: {
											display: "flex",
											flexDirection: "column",
											justifyContent: "center",
											flex: 1,
										},
										children: [
											// Title
											{
												type: "div",
												props: {
													style: {
														fontSize: "64px",
														fontWeight: 700,
														color: "#0f172a",
														lineHeight: 1.1,
														letterSpacing: "-2px",
														marginBottom: "32px",
													},
													children: displayTitle,
												},
											},
											// Description
											description
												? {
														type: "div",
														props: {
															style: {
																fontSize: "32px",
																fontWeight: 500,
																color: "#64748b",
																lineHeight: 1.4,
															},
															children: displayDesc,
														},
													}
												: null,
										].filter(Boolean),
									},
								},
								// Footer with author and URL
								{
									type: "div",
									props: {
										style: {
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											borderTop: "1px solid #f1f5f9",
											paddingTop: "40px",
											marginTop: "40px",
										},
										children: [
											// Author section
											{
												type: "div",
												props: {
													style: {
														display: "flex",
														alignItems: "center",
														gap: "24px",
													},
													children: [
														// Photo container with accent dot
														{
															type: "div",
															props: {
																style: {
																	position: "relative",
																	display: "flex",
																},
																children: [
																	// Photo with border
																	{
																		type: "img",
																		props: {
																			src: photoBase64,
																			width: 80,
																			height: 80,
																			style: {
																				borderRadius: "50%",
																				objectFit: "cover",
																				border: "4px solid #ffffff",
																				boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
																			},
																		},
																	},
																	// Accent dot
																	{
																		type: "div",
																		props: {
																			style: {
																				position: "absolute",
																				bottom: "4px",
																				right: "4px",
																				width: "20px",
																				height: "20px",
																				borderRadius: "50%",
																				backgroundColor: accentColor,
																				border: "3px solid #ffffff",
																			},
																		},
																	},
																],
															},
														},
														// Name only
														{
															type: "div",
															props: {
																style: {
																	fontSize: "28px",
																	fontWeight: 700,
																	color: "#1e293b",
																},
																children: OG_NAME,
															},
														},
													],
												},
											},
											// Website URL with globe icon
											{
												type: "div",
												props: {
													style: {
														display: "flex",
														alignItems: "center",
														gap: "12px",
													},
													children: [
														// Simple wireframe globe icon
														{
															type: "svg",
															props: {
																width: 32,
																height: 32,
																viewBox: "0 0 24 24",
																fill: "none",
																children: [
																	// Outer circle
																	{
																		type: "circle",
																		props: {
																			cx: 12,
																			cy: 12,
																			r: 10,
																			stroke: "#94a3b8",
																			strokeWidth: 2,
																		},
																	},
																	// Vertical meridian (ellipse)
																	{
																		type: "ellipse",
																		props: {
																			cx: 12,
																			cy: 12,
																			rx: 4,
																			ry: 10,
																			stroke: "#94a3b8",
																			strokeWidth: 2,
																		},
																	},
																	// Horizontal equator
																	{
																		type: "path",
																		props: {
																			d: "M2 12h20",
																			stroke: "#94a3b8",
																			strokeWidth: 2,
																		},
																	},
																],
															},
														},
														{
															type: "div",
															props: {
																style: {
																	fontSize: "26px",
																	fontWeight: 600,
																	color: "#475569",
																	letterSpacing: "0.5px",
																},
																children: OG_FOOTER_TEXT,
															},
														},
													],
												},
											},
										],
									},
								},
							],
						},
					},
				],
			},
		},
		{
			width: 1200,
			height: 630,
			fonts: [
				{
					name: ogFonts.family,
					data: ogFonts.regularData,
					weight: 400,
					style: "normal",
				},
				{
					name: ogFonts.family,
					data: ogFonts.regularData,
					weight: 500,
					style: "normal",
				},
				{
					name: ogFonts.family,
					data: ogFonts.boldData,
					weight: 600,
					style: "normal",
				},
				{
					name: ogFonts.family,
					data: ogFonts.boldData,
					weight: 700,
					style: "normal",
				},
			],
		},
	);

	return svg;
}

async function svgToJpeg(svg) {
	const resvg = new Resvg(svg, {
		fitTo: {
			mode: "width",
			value: 1200,
		},
	});
	const pngData = resvg.render();
	const pngBuffer = pngData.asPng();

	const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 90 }).toBuffer();

	return jpegBuffer;
}

async function main() {
	const start = Date.now();
	const ogFonts = await loadOgFonts();

	log.banner("og");
	if (ogFonts.source === "google") {
		log.verb(`using font: ${ogFonts.family} (cached at ${path.relative(rootDir, ogFonts.regularPath)})`);
	} else {
		log.verb(`using system fonts: ${path.basename(ogFonts.regularPath)}, ${path.basename(ogFonts.boldPath)}`);
	}

	if (!fs.existsSync(PAGES_OG_DIR)) {
		fs.mkdirSync(PAGES_OG_DIR, { recursive: true });
	}

	const cache = loadCache();

	const blogPosts = getPosts(BLOG_DIR, "blog");
	const rawPosts = getPosts(RAW_DIR, "raw");
	const pages = getPages();
	const homepage = getHomepage();
	const allItems = [...blogPosts, ...rawPosts, ...pages, homepage];

	log.verb(`checking ${blogPosts.length} blog posts, ${rawPosts.length} raw notes, ${pages.length + 1} pages`);

	let generated = 0;
	let unchanged = 0;
	let failed = 0;
	const details = [];

	for (const item of allItems) {
		const outputPath =
			item.collection === "pages"
				? path.join(PAGES_OG_DIR, `${item.slug}.jpeg`)
				: path.join(item.folderPath, "og.jpeg");

		const cacheKey = `${item.collection}-${item.slug}`;

		// An existing image with no cache entry was added by hand, so keep it.
		const cached = cache[cacheKey];
		if (item.hasCustomImage || (fs.existsSync(outputPath) && (cached === undefined || cached === item.contentHash))) {
			unchanged++;
			continue;
		}

		try {
			const svg = await generateOgSvg(item.title, item.description, ogFonts);

			const jpeg = await svgToJpeg(svg);

			fs.writeFileSync(outputPath, jpeg);

			cache[cacheKey] = item.contentHash;

			generated++;
			details.push(item.collection === "pages" ? `pages/${item.slug}.jpeg` : `${item.collection}/${item.slug}/og.jpeg`);
		} catch (error) {
			failed++;
			log.failDetail(`${item.collection}/${item.slug}: ${error.message}`);
		}
	}

	saveCache(cache);

	const parts = [];
	if (generated > 0) parts.push(`generated ${generated}`);
	parts.push(`${unchanged} unchanged`);
	if (failed > 0) parts.push(`${failed} failed`);

	const summary = `${parts.join(" · ")} (${elapsedSince(start)})`;
	if (failed > 0) {
		log.warn("og", summary);
	} else {
		log.step("og", summary);
	}
	for (const detail of details) log.detail(detail);

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((error) => {
	log.fail("og", error.message);
	process.exit(1);
});
