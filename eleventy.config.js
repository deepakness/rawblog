import { InputPathToUrlTransformPlugin, HtmlBasePlugin } from "@11ty/eleventy";
import pluginRss from "@11ty/eleventy-plugin-rss";
import pluginSyntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import eleventyPluginPhosphoricons from "eleventy-plugin-phosphoricons";
import embedEverything from "eleventy-plugin-embed-everything";
import { readImageSize, resetImageSizeCache } from "./_config/imageSize.js";
import fs from "fs";
import { DateTime } from "luxon";

import pluginFilters from "./_config/filters.js";
import { excludedTagSet } from "./_config/excludedTags.js";
import { buildRelatedMap } from "./_config/related.js";
import { isDraftData } from "./_config/drafts.js";
import { ASSET_ORIGIN, SITE_URL, SITE_ZONE } from "./_config/site.js";

/** @param {import("@11ty/eleventy").UserConfig} eleventyConfig */
export default async function (eleventyConfig) {
	const assetOrigin = ASSET_ORIGIN;
	const siteOrigin = SITE_URL.toLowerCase();

	// Image dimensions for pictureTag; loaded once per build.
	let imageCache = {};
	eleventyConfig.on("eleventy.before", () => {
		resetImageSizeCache();
		try {
			imageCache = JSON.parse(fs.readFileSync("_data/cache/image-cache.json", "utf-8"));
		} catch {
			imageCache = {};
		}
	});

	eleventyConfig.addGlobalData("assetOrigin", assetOrigin);

	eleventyConfig.addFilter("resolveSocialImageUrl", function (imagePath, siteUrl = "") {
		if (!imagePath) {
			return "";
		}

		if (/^https?:\/\//i.test(imagePath)) {
			return imagePath;
		}

		if (assetOrigin && (imagePath.startsWith("/blog/") || imagePath.startsWith("/raw/"))) {
			return `${assetOrigin}${imagePath}`;
		}

		return `${siteUrl}${imagePath}`;
	});

	// Content embed plugins and icons used across templates.
	eleventyConfig.addPlugin(embedEverything, {
		youtube: {
			options: {
				lite: true,
				recommendSelfOnly: true,
			},
		},
		twitter: {
			options: {
				theme: "light",
				cacheText: true,
				cacheDuration: "1440m",
				conversation: "none",
			},
		},
	});

	eleventyConfig.addPlugin(eleventyPluginPhosphoricons, {
		class: "social-icon",
		size: 18,
		fill: "currentColor",
		style: "vertical-align: middle;",
	});

	// Exclude draft content during production builds.
	eleventyConfig.addPreprocessor("drafts", "*", (data, content) => {
		if (isDraftData(data) && process.env.ELEVENTY_RUN_MODE !== "serve") {
			return false;
		}
	});

	// External links: open in a new tab with safe rel, but preserve intentional
	// tokens (especially rel="me" for IndieWeb / Mastodon identity).
	eleventyConfig.addTransform("externalLinks", (content, outputPath) => {
		if (!outputPath || !outputPath.endsWith(".html")) {
			return content;
		}

		try {
			return content.replace(/<a\s+([^>]*?)>/gi, (full, attrs) => {
				const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
				if (!hrefMatch) {
					return full;
				}

				const href = hrefMatch[2];
				if (!/^(?:https?:)?\/\//i.test(href)) {
					return full;
				}

				let nextAttrs = attrs;

				if (/\btarget\s*=/i.test(nextAttrs)) {
					nextAttrs = nextAttrs.replace(/\btarget\s*=\s*(["']).*?\1/i, 'target="_blank"');
				} else {
					nextAttrs += ' target="_blank"';
				}

				const relMatch = nextAttrs.match(/\brel\s*=\s*(["'])(.*?)\1/i);
				const tokens = new Set();
				if (relMatch) {
					for (const token of relMatch[2].split(/\s+/)) {
						if (token) {
							tokens.add(token);
						}
					}
				}
				tokens.add("noopener");
				tokens.add("noreferrer");
				const relValue = [...tokens].join(" ");

				if (relMatch) {
					nextAttrs = nextAttrs.replace(/\brel\s*=\s*(["']).*?\1/i, `rel="${relValue}"`);
				} else {
					nextAttrs += ` rel="${relValue}"`;
				}

				return `<a ${nextAttrs.trim()}>`;
			});
		} catch (error) {
			console.error("externalLinks transform failed:", error);
			return content;
		}
	});

	// Static assets and feed stylesheet passthrough.
	eleventyConfig
		.addPassthroughCopy({
			"./public/": "/",
		})
		.addPassthroughCopy({
			"./node_modules/fuse.js/dist/fuse.min.mjs": "/js/fuse.min.mjs",
		})
		.addPassthroughCopy("./content/feed/pretty-atom-feed.xsl")
		.addPassthroughCopy("./content/blog/**/*.{jpg,png,webp,jpeg,gif,avif,mp4,webm,mov}")
		.addPassthroughCopy("./content/raw/**/*.{jpg,png,webp,jpeg,gif,avif,mp4,webm,mov}");

	// Watch image assets used by the picture transform pipeline.
	eleventyConfig.addWatchTarget("content/**/*.{svg,webp,png,jpg,jpeg,gif}");

	// Per-page asset bundles.
	// `css` stays inlined: it only carries the few per-page rules (e.g. the
	// postlist counter-reset), which differ page to page and are far too small
	// to be worth a request.
	eleventyConfig.addBundle("css", {
		toFileDirectory: "dist",
	});
	// `sitecss` is the shared stylesheet. Its contents are byte-identical on
	// every page, so it hashes to one file the browser caches once instead of
	// being inlined into every page.
	eleventyConfig.addBundle("sitecss", {
		// Must end in .css: the host serves unknown extensions as
		// application/octet-stream, and browsers refuse to apply a stylesheet
		// whose MIME type is not text/css.
		outputFileExtension: "css",
		toFileDirectory: "dist",
	});
	// `prismcss` is the syntax-highlighting theme, only on posts and notes.
	// Separate bundle so it stays one cacheable file shared by those pages
	// rather than changing the shared stylesheet's hash.
	eleventyConfig.addBundle("prismcss", {
		outputFileExtension: "css",
		toFileDirectory: "dist",
	});
	eleventyConfig.addBundle("js", {
		toFileDirectory: "dist",
	});

	// Core Eleventy plugins.
	eleventyConfig.addPlugin(pluginSyntaxHighlight, {
		preAttributes: { tabindex: 0 },
	});
	eleventyConfig.addPlugin(HtmlBasePlugin);
	eleventyConfig.addPlugin(pluginRss);
	eleventyConfig.addPlugin(InputPathToUrlTransformPlugin);

	// Content collections.
	// Same draft policy as the "drafts" preprocessor above (_config/drafts.js).
	const isPublished = (item) => !isDraftData(item.data || {});
	const published = (items) => items.filter(isPublished);

	eleventyConfig.addCollection("raw", function (collectionApi) {
		return published(collectionApi.getFilteredByGlob("content/raw/*/index.md"));
	});

	// Related entries for the "Keep reading" block, keyed by URL.
	// Scored once for the whole corpus here rather than per page in a template.
	eleventyConfig.addCollection("related", function (collectionApi) {
		const blogPosts = published(collectionApi.getFilteredByTag("posts"));
		const rawNotes = published(collectionApi.getFilteredByGlob("content/raw/*/index.md"));
		return buildRelatedMap([...blogPosts, ...rawNotes]);
	});

	// Sorted list of non-empty content tags (excludes system collections / cascade tags).
	eleventyConfig.addCollection("contentTagList", function (collectionApi) {
		const tagSet = new Set();
		for (const item of collectionApi.getAll()) {
			const tags = item.data?.tags;
			if (!tags) continue;
			for (const tag of Array.isArray(tags) ? tags : [tags]) {
				if (tag && !excludedTagSet.has(tag)) {
					tagSet.add(tag);
				}
			}
		}
		return [...tagSet].sort((a, b) => a.localeCompare(b));
	});

	eleventyConfig.addCollection("archiveFeed", function (collectionApi) {
		const blogPosts = published(collectionApi.getFilteredByTag("posts"));
		const rawNotes = published(collectionApi.getFilteredByGlob("content/raw/*/index.md"));
		return [...blogPosts, ...rawNotes].sort((a, b) => b.date - a.date);
	});

	// Blended homepage feed with minimum representation for both types.
	eleventyConfig.addCollection("homeFeedBlended", function (collectionApi) {
		const limit = 12;
		const minBlogs = 3;
		const minNotes = 3;

		const blogPosts = published(collectionApi.getFilteredByTag("posts")).sort((a, b) => b.date - a.date);
		const rawNotes = published(collectionApi.getFilteredByGlob("content/raw/*/index.md")).sort(
			(a, b) => b.date - a.date,
		);

		const selected = [];
		const selectedUrls = new Set();

		function toHomeEntry(item, entryType) {
			return {
				url: item.url,
				date: item.date,
				data: item.data,
				inputPath: item.inputPath,
				entryType,
			};
		}

		function addFrom(items, count, entryType) {
			let added = 0;
			for (const item of items) {
				if (selected.length >= limit || added >= count) {
					break;
				}
				if (!item?.url || selectedUrls.has(item.url)) {
					continue;
				}
				selected.push(toHomeEntry(item, entryType));
				selectedUrls.add(item.url);
				added += 1;
			}
		}

		addFrom(blogPosts, minBlogs, "blog");
		addFrom(rawNotes, minNotes, "note");

		const remaining = [
			...blogPosts.map((item) => toHomeEntry(item, "blog")),
			...rawNotes.map((item) => toHomeEntry(item, "note")),
		].sort((a, b) => b.date - a.date);

		for (const item of remaining) {
			if (selected.length >= limit) {
				break;
			}
			if (!item?.url || selectedUrls.has(item.url)) {
				continue;
			}
			selected.push(item);
			selectedUrls.add(item.url);
		}

		return selected.sort((a, b) => b.date - a.date);
	});

	// Archive entries grouped by year/month for archive pages.
	eleventyConfig.addCollection("archiveByYear", function (collectionApi) {
		const blogPosts = published(collectionApi.getFilteredByTag("posts"));
		const rawNotes = published(collectionApi.getFilteredByGlob("content/raw/*/index.md"));

		const entries = [
			...blogPosts.map((post) => ({ post, entryType: "blog" })),
			...rawNotes.map((post) => ({ post, entryType: "raw" })),
		]
			.map(({ post, entryType }) => {
				const dt = DateTime.fromJSDate(post.date, { zone: SITE_ZONE });
				const tags = Array.isArray(post.data.tags) ? post.data.tags : post.data.tags ? [post.data.tags] : [];

				return {
					title: post.data.title || post.url,
					url: post.url,
					date: post.date,
					updated: post.data.updated,
					inputPath: post.inputPath,
					tags,
					entryType,
					year: dt.toFormat("yyyy"),
					monthKey: dt.toFormat("yyyy-LL"),
					monthLabel: dt.toFormat("LLL yyyy"),
					monthName: dt.toFormat("LLLL"),
				};
			})
			.sort((a, b) => b.date - a.date);

		const totalCount = entries.length;
		entries.forEach((entry, index) => {
			entry.totalNumber = totalCount - index;
		});

		const yearsMap = new Map();

		for (const entry of entries) {
			if (!yearsMap.has(entry.year)) {
				yearsMap.set(entry.year, {
					year: entry.year,
					totalCount: 0,
					monthsMap: new Map(),
				});
			}

			const yearGroup = yearsMap.get(entry.year);
			yearGroup.totalCount += 1;

			if (!yearGroup.monthsMap.has(entry.monthKey)) {
				yearGroup.monthsMap.set(entry.monthKey, {
					monthKey: entry.monthKey,
					monthLabel: entry.monthLabel,
					monthName: entry.monthName,
					year: entry.year,
					blogCount: 0,
					noteCount: 0,
					entries: [],
				});
			}

			const monthGroup = yearGroup.monthsMap.get(entry.monthKey);
			monthGroup.entries.push(entry);
			if (entry.entryType === "blog") {
				monthGroup.blogCount += 1;
			} else {
				monthGroup.noteCount += 1;
			}
		}

		const yearGroups = Array.from(yearsMap.values())
			.sort((a, b) => b.year.localeCompare(a.year))
			.map((yearGroup) => {
				const months = Array.from(yearGroup.monthsMap.values())
					.sort((a, b) => b.monthKey.localeCompare(a.monthKey))
					.map((monthGroup) => ({
						monthKey: monthGroup.monthKey,
						monthLabel: monthGroup.monthLabel,
						monthName: monthGroup.monthName,
						year: monthGroup.year,
						blogCount: monthGroup.blogCount,
						noteCount: monthGroup.noteCount,
						totalCount: monthGroup.entries.length,
						entries: monthGroup.entries.sort((a, b) => b.date - a.date),
					}));

				const yearNum = Number(yearGroup.year);
				const decadeStart = Number.isFinite(yearNum) ? Math.floor(yearNum / 10) * 10 : yearGroup.year;

				return {
					year: yearGroup.year,
					totalCount: yearGroup.totalCount,
					decade: `${decadeStart}s`,
					months,
				};
			});

		const maxYearCount = yearGroups.reduce((max, yearGroup) => Math.max(max, yearGroup.totalCount), 0);

		return yearGroups.map((yearGroup) => ({
			...yearGroup,
			fillRatio: maxYearCount > 0 ? Math.round((yearGroup.totalCount / maxYearCount) * 1000) / 1000 : 0,
		}));
	});

	// Wrap JPG/PNG <img> tags with <picture> and optional WebP source.
	// Dimensions come from imageCache loaded once in eleventy.before.
	eleventyConfig.addTransform("pictureTag", function (content, outputPath) {
		// Only process generated blog/raw HTML pages.
		if (
			!outputPath ||
			!outputPath.endsWith(".html") ||
			(!outputPath.includes("/blog/") && !outputPath.includes("/raw/"))
		) {
			return content;
		}

		let slug = null;
		let collection = null;

		const blogMatch = outputPath.match(/\/blog\/([^/]+)\//);
		const rawMatch = outputPath.match(/\/raw\/([^/]+)\//);

		if (blogMatch) {
			slug = blogMatch[1];
			collection = "blog";
		} else if (rawMatch) {
			slug = rawMatch[1];
			collection = "raw";
		}

		function resolveScopedImageSrc(src) {
			if (!slug || !collection) {
				return src;
			}

			if (src.startsWith("./")) {
				return `/${collection}/${slug}/${src.substring(2)}`;
			}

			if (
				!/^(?:https?:)?\/\//i.test(src) &&
				!src.startsWith("/") &&
				!src.startsWith("../") &&
				!src.startsWith("#") &&
				!src.startsWith("data:")
			) {
				return `/${collection}/${slug}/${src}`;
			}

			return src;
		}

		function toAssetUrl(src) {
			return src.startsWith("/blog/") || src.startsWith("/raw/") ? `${assetOrigin}${src}` : src;
		}

		// Width/height come from the optimizer cache, keyed by the source file
		// on disk. Derive the key from the image path itself rather than the
		// page's own slug, so listing pages (/raw/, /blog/) get dimensions too
		// and not just the individual entry pages.
		function cachedDimensions(resolvedSrc, rawSrc) {
			let cacheKey = null;

			const scoped = resolvedSrc.match(/^\/(blog|raw)\/([^/]+)\/(.+)$/);
			if (scoped) {
				cacheKey = `content/${scoped[1]}/${scoped[2]}/${scoped[3]}`;
			} else if (slug && collection) {
				cacheKey = `content/${collection}/${slug}/${rawSrc.replace(/^\.\//, "")}`;
			}

			const cached = cacheKey ? imageCache[cacheKey] : null;
			if (cached?.width && cached?.height) {
				return cached;
			}

			// The optimizer only records JPEG and PNG sources, so a .webp or .gif
			// committed straight into a post has no cache entry. Read the header
			// off disk instead, so those still reserve their space.
			if (cacheKey) {
				const measured = readImageSize(cacheKey);
				if (measured) return measured;
			}

			return null;
		}

		// Document order matters for loading strategy: the first content image
		// stays eager (and high priority) so it can still serve as the LCP
		// candidate; everything below it is lazy.
		const firstImgMatch = content.match(/<img\s+(?![^>]*data-no-picture)[^>]*src=["']([^"']+)["'][^>]*>/i);
		const firstImgSrc = firstImgMatch ? firstImgMatch[1] : null;

		function loadingAttrFor(rawSrc) {
			return rawSrc === firstImgSrc ? ' loading="eager" fetchpriority="high"' : ' loading="lazy"';
		}

		const transformedContent = content.replace(
			/<img\s+([^>]*?)src=["']([^"']+\.(jpg|jpeg|png))["']([^>]*)>/gi,
			(match, before, src, ext, after) => {
				if (match.includes("data-no-picture")) {
					return match;
				}

				// Resolve relative image paths for co-located assets.
				const rawSrc = src;
				src = resolveScopedImageSrc(src);

				const webpSrc = src.replace(/\.(jpg|jpeg|png)$/i, ".webp");
				const outputSrc = toAssetUrl(src);
				const outputWebpSrc = toAssetUrl(webpSrc);

				let attrs = before + after;
				if (!attrs.includes("decoding=")) {
					attrs += ' decoding="async"';
				}

				// Add width/height from cache when available (prevents layout shift).
				if (!attrs.includes("width=")) {
					const cached = cachedDimensions(src, rawSrc);
					if (cached) {
						attrs += ` width="${cached.width}" height="${cached.height}"`;
					}
				}

				if (!attrs.includes("loading=")) {
					attrs += loadingAttrFor(rawSrc);
				}

				return `<picture>
  <source srcset="${outputWebpSrc}" type="image/webp">
  <img ${attrs.trim()} src="${outputSrc}">
</picture>`;
			},
		);

		return transformedContent.replace(
			/<img\s+([^>]*?)src=["']([^"']+\.(webp|gif|avif))["']([^>]*)>/gi,
			(match, before, src, ext, after) => {
				if (match.includes("data-no-picture")) {
					return match;
				}

				const resolvedSrc = resolveScopedImageSrc(src);
				const outputSrc = toAssetUrl(resolvedSrc);
				let attrs = before + after;
				if (!attrs.includes("decoding=")) {
					attrs += ' decoding="async"';
				}

				if (!attrs.includes("width=")) {
					const cached = cachedDimensions(resolvedSrc, src);
					if (cached) {
						attrs += ` width="${cached.width}" height="${cached.height}"`;
					}
				}

				if (!attrs.includes("loading=")) {
					attrs += loadingAttrFor(src);
				}

				return `<img ${attrs.trim()} src="${outputSrc}">`;
			},
		);
	});

	// Pages with a {% video %} embed get the Plyr player assets injected
	// into <head>. Runs as a transform (after layout render), so it works in
	// watch mode and never touches video-less pages.
	eleventyConfig.addTransform("plyrAssets", function (content, outputPath) {
		if (!outputPath || !outputPath.endsWith(".html") || !content.includes("data-plyr")) {
			return content;
		}

		const assets = [
			'<link rel="stylesheet" href="/css/plyr.css">',
			'<script src="/js/plyr.min.js" defer></script>',
			'<script src="/js/video.js" defer></script>',
		].join("\n");

		return content.replace("</head>", `${assets}\n</head>`);
	});

	// Rewrite image URLs in feed XML to point to the R2 asset origin and
	// strip <picture> wrappers down to plain <img> for RSS reader compatibility.
	// Feed content is HTML-entity-encoded, so we match encoded tags.
	eleventyConfig.addTransform("feedImages", function (content, outputPath) {
		if (!outputPath || !outputPath.endsWith(".xml")) {
			return content;
		}

		// Strip encoded <picture>…</picture> wrappers, keeping just the <img> tag.
		content = content.replace(
			/&lt;picture&gt;[\s\S]*?(&lt;img\s[\s\S]*?&gt;)\s*&lt;\/picture&gt;/gi,
			(match, imgTag) => imgTag,
		);
		return content.replace(
			/(https?:\/\/[^/\s&"'<>]+)\/((?:blog|raw)\/[^\s&"'<>]+\.(?:jpg|jpeg|png|webp|gif))/gi,
			(match, origin, path) => {
				// Only our own hosts carry /blog/ and /raw/ media. Rewriting any
				// other origin would corrupt external links that merely share the
				// path shape (e.g. someone.com/blog/photo.jpg).
				const normalizedOrigin = origin.toLowerCase();
				if (!assetOrigin || (normalizedOrigin !== assetOrigin.toLowerCase() && normalizedOrigin !== siteOrigin)) {
					return match;
				}
				return `${assetOrigin}/${path}`;
			},
		);
	});

	// Shared filters and project-specific shortcodes.
	eleventyConfig.addPlugin(pluginFilters);

	eleventyConfig.addShortcode("currentBuildDate", () => {
		return new Date().toISOString();
	});

	// Embeds a self-hosted video with sensible defaults: nothing is fetched
	// until the visitor presses play; the poster stands in meanwhile.
	// Usage:
	//   {% video "./clip.mp4" %}
	// The poster defaults to the pipeline convention <base>-poster.webp
	// (generated automatically by scripts/process-videos.js). Pass a second
	// argument to override it:
	//   {% video "https://assets.example.com/videos/clip.mp4", "https://assets.example.com/videos/clip-poster.webp" %}
	// Absolute URLs pass through. Relative (./) paths resolve against the
	// page's collection/slug on the asset origin, like content images.
	eleventyConfig.addShortcode("video", function (src, poster) {
		const pageUrl = this.page?.url || "";

		function resolveVideoSrc(rawSrc) {
			if (!rawSrc) {
				return "";
			}

			if (/^https?:\/\//i.test(rawSrc)) {
				return rawSrc;
			}

			const scoped = pageUrl.match(/^\/(blog|raw)\/([^/]+)\//);
			if (rawSrc.startsWith("./") && scoped) {
				return `${assetOrigin}/${scoped[1]}/${scoped[2]}/${rawSrc.substring(2)}`;
			}

			if (rawSrc.startsWith("/blog/") || rawSrc.startsWith("/raw/")) {
				return `${assetOrigin}${rawSrc}`;
			}

			return rawSrc;
		}

		const srcUrl = resolveVideoSrc(src);

		// No explicit poster? Derive the pipeline convention <base>-poster.webp.
		// process-videos.js guarantees a poster for every processed video.
		function derivePoster(rawSrc) {
			const base = rawSrc.split("?")[0];
			const dot = base.lastIndexOf(".");
			if (dot <= base.lastIndexOf("/")) {
				return null;
			}
			return `${base.slice(0, dot)}-poster.webp`;
		}

		const posterUrl = resolveVideoSrc(poster || derivePoster(src) || "");
		const ext = srcUrl.split("?")[0].split(".").pop()?.toLowerCase() || "mp4";
		const type = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }[ext] || "video/mp4";

		return `<video controls preload="none" playsinline data-plyr${posterUrl ? ` poster="${posterUrl}"` : ""}>
  <source src="${srcUrl}" type="${type}">
</video>`;
	});

	eleventyConfig.addFilter("dateToISO", function (date) {
		return date ? new Date(date).toISOString() : "";
	});

	// Inner body of a JSON string literal, for embedding inside `"…"`.
	// Null/undefined yield an empty literal, and `<` is escaped so a value
	// containing `</script>` cannot break out of an inline script.
	eleventyConfig.addFilter("json", function (value) {
		const encoded = JSON.stringify(value ?? "");
		return encoded.slice(1, -1).replace(/</g, "\\u003c");
	});

	eleventyConfig.addFilter("push", function (arr, item) {
		return [...arr, item];
	});
}

export const config = {
	templateFormats: ["md", "njk", "html"],

	markdownTemplateEngine: "njk",

	htmlTemplateEngine: "njk",

	dir: {
		input: "content",
		includes: "../_includes",
		data: "../_data",
		output: "_site",
	},
};
