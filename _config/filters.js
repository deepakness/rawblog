import { DateTime } from "luxon";
import { SITE_ZONE, siteNow, toSiteDateTime } from "./time.js";
import site, { ASSET_ORIGIN, SITE_URL } from "./site.js";
import fs from "fs";
import path from "path";
import { EXCLUDED_TAGS } from "./excludedTags.js";
import { warnAboutUncountedPages } from "./wordCountPages.js";

// Per-file word breakdowns within a build (shared by siteStats + per-page filters)
let wordBreakdownCache = new Map();

// Cleared at the start of every build, including watch-mode rebuilds.
function resetStatsCache() {
	wordBreakdownCache.clear();
}

/**
 * Which buckets of a file's word breakdown each surface adds up.
 *
 * READER  – what someone actually reads on the page. Drives the per-post word
 *           count and reading time. Alt text is excluded: it is never rendered
 *           for a sighted reader, so counting it overstates the page.
 * ARCHIVE – everything written, alt text included. Drives the sitewide totals
 *           in the footer, on /about, and in the /stats hero.
 *
 * The two differ by roughly 1% of the corpus, so per-post figures do not sum
 * exactly to the sitewide total. That is deliberate and stated on /stats.
 */
export const WORD_POLICY = {
	READER: ["title", "prose", "code"],
	ARCHIVE: ["title", "prose", "code", "alt"],
};

// Count tokens that look like real words (at least one letter or digit).
function countWordsInString(text) {
	if (!text) return 0;
	return text.split(/\s+/).filter((w) => w.length > 0 && /[\p{L}\p{N}]/u.test(w)).length;
}

// Frontmatter `title` only — never description or other fields.
function extractFrontmatterTitle(content) {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fmMatch) return "";

	const titleLine = fmMatch[1].match(/^title:\s*(.*)$/m);
	if (!titleLine) return "";

	let title = titleLine[1].trim();

	// YAML double-quoted: "..."
	if (title.startsWith('"')) {
		const m = title.match(/^"(.*)"\s*$/);
		title = m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : title.slice(1);
	}
	// YAML single-quoted: '...' ('' → ')
	else if (title.startsWith("'")) {
		const m = title.match(/^'(.*)'\s*$/);
		title = m ? m[1].replace(/''/g, "'") : title.slice(1);
	}

	return title.trim();
}

// Drop CSS/JS/asset tags and Nunjucks so template chrome never becomes "words".
// Safe on plain markdown posts (those constructs are rare/absent).
function stripTemplateAndAssetChrome(text) {
	if (!text) return "";

	let body = text;

	// <style>…</style> and <script>…</script> (inline or external)
	body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
	// Stylesheet / preload links (no body text to keep)
	body = body.replace(/<link\b[^>]*>/gi, " ");

	// Nunjucks comments, tags, and expressions — avoids counting loops, filters,
	// and injected collection content (e.g. {{ note.templateContent }})
	body = body.replace(/{#[\s\S]*?#}/g, " ");
	body = body.replace(/{%-?[\s\S]*?-?%}/g, " ");
	body = body.replace(/{{-?[\s\S]*?-?}}/g, " ");

	return body;
}

// Punctuation cleanup shared by every bucket, so a word is counted the same way
// whether it came from prose, a heading, alt text, or a code sample.
function normalizeChrome(text) {
	if (!text) return "";
	// Leftover markdown punctuation → spaces (keep hyphens inside words)
	return text
		.replace(/[#*_~`>|\[\](){}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Pull fenced code blocks out of the body, returning their contents separately.
// Extracted first so the inline-code and emphasis passes cannot mangle them, and
// so an image written inside a code sample is never read as a real image.
function extractFencedCode(text) {
	const blocks = [];
	const rest = text.replace(/```[\s\S]*?```/g, (block) => {
		// Drop the fence lines themselves so the language tag is not a "word"
		blocks.push(block.replace(/^```.*$/gm, " "));
		return " ";
	});
	return { code: blocks.join("\n"), rest };
}

// Pull image alt text out of the body, returning it separately so each surface
// can decide whether to count it. Everything else about an image (src, markup)
// is dropped either way.
function extractAltText(text) {
	const alts = [];
	const keep = (_match, alt) => {
		alts.push(alt);
		return " ";
	};

	let rest = text;
	rest = rest.replace(/!\[([^\]]*)\]\([^)]*\)/g, keep);
	rest = rest.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, keep);
	rest = rest.replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>/gi, keep);
	rest = rest.replace(/<img\b[^>]*\balt\s*=\s*'([^']*)'[^>]*>/gi, keep);
	rest = rest.replace(/<img\b[^>]*>/gi, " "); // remaining img tags without alt

	return { alt: alts.join(" "), rest };
}

// Strip markdown/HTML chrome from body text, then count each bucket separately.
function bodyBreakdown(text) {
	if (!text) return { prose: 0, alt: 0, code: 0 };

	let body = stripTemplateAndAssetChrome(text);

	// HTML comments
	body = body.replace(/<!--[\s\S]*?-->/g, " ");

	// Fenced code, then images, before the link rewrite below
	const fenced = extractFencedCode(body);
	const images = extractAltText(fenced.rest);
	body = images.rest;

	// Remaining HTML tags
	body = body.replace(/<\/?[^>]+>/g, " ");

	// Markdown links → keep visible link text only
	body = body.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	body = body.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

	// Footnote refs
	body = body.replace(/\[\^[^\]]*\]/g, " ");

	// Bare URLs
	body = body.replace(/https?:\/\/[^\s)\]>'"]+/g, " ");
	body = body.replace(/\bwww\.[^\s)\]>'"]+/gi, " ");

	// Inline code: drop backticks, keep the text (short identifiers)
	body = body.replace(/`([^`]+)`/g, "$1");

	// Structural markdown markers
	body = body.replace(/^#{1,6}\s+/gm, "");
	body = body.replace(/^\s{0,3}>\s?/gm, "");
	body = body.replace(/^\s*[-*+]\s+/gm, "");
	body = body.replace(/^\s*\d+\.\s+/gm, "");

	// Emphasis / strikethrough wrappers
	body = body.replace(/(\*\*|__)(.*?)\1/g, "$2");
	body = body.replace(/(\*|_)(.*?)\1/g, "$2");
	body = body.replace(/~~(.*?)~~/g, "$1");

	return {
		prose: countWordsInString(normalizeChrome(body)),
		alt: countWordsInString(normalizeChrome(images.alt)),
		code: countWordsInString(normalizeChrome(fenced.code)),
	};
}

/**
 * Word breakdown for one content file (post, note, build-log entry, page),
 * cached per path for the current build. A surface's total is the sum of the
 * buckets its WORD_POLICY names, so changing what counts where is a summing
 * decision rather than a second pass over the file.
 *
 * `title` is the frontmatter title, counted because it is rendered on the page.
 * The rest of the frontmatter (description, tags, dates) is never counted.
 *
 * Exported so _data/siteStats.js shares the exact same numbers (and cache).
 */
function wordBreakdown(inputPath) {
	if (!inputPath) return { title: 0, prose: 0, alt: 0, code: 0 };

	const cacheKey = path.normalize(String(inputPath));
	if (wordBreakdownCache.has(cacheKey)) {
		return wordBreakdownCache.get(cacheKey);
	}

	let result = { title: 0, prose: 0, alt: 0, code: 0 };
	try {
		const content = fs.readFileSync(cacheKey, "utf-8");

		const title = countWordsInString(extractFrontmatterTitle(content));

		// Drop entire frontmatter block so description/tags/dates never enter a bucket
		const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

		result = { title, ...bodyBreakdown(body) };
	} catch {
		// An unreadable file counts as nothing rather than breaking the build
	}

	wordBreakdownCache.set(cacheKey, result);
	return result;
}

/** Sum one file's breakdown under a WORD_POLICY. Defaults to the sitewide policy. */
export function countWordsInFile(inputPath, policy = WORD_POLICY.ARCHIVE) {
	const breakdown = wordBreakdown(inputPath);
	return policy.reduce((total, bucket) => total + breakdown[bucket], 0);
}

// Exported so _data/siteStats.js shares the exact same numbers.
export function countImagesInFile(inputPath) {
	try {
		const content = fs.readFileSync(inputPath, "utf-8");
		const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, "");
		// Remove code blocks (``` ... ```) to avoid counting code examples as images
		const withoutCodeBlocks = withoutFrontmatter.replace(/```[\s\S]*?```/g, "");
		const cleanContent = withoutCodeBlocks.replace(/`[^`]+`/g, "");
		const markdownImages = (cleanContent.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
		const htmlImages = (cleanContent.match(/<img[^>]+>/gi) || []).length;
		return markdownImages + htmlImages;
	} catch {
		return 0;
	}
}

export default function (eleventyConfig) {
	// Reset cache at the start of each build (important for watch mode)
	eleventyConfig.on("eleventy.before", () => {
		resetStatsCache();
		warnAboutUncountedPages();
	});

	eleventyConfig.addFilter("readingTimeMinutes", function (inputPath) {
		if (!inputPath) return "1 min";
		const words = countWordsInFile(inputPath, WORD_POLICY.READER);
		const minutes = Math.max(1, Math.ceil(words / 200));
		return `${minutes} min`;
	});

	eleventyConfig.addFilter("wordCount", function (inputPath) {
		if (!inputPath) return "0 words";
		const words = countWordsInFile(inputPath, WORD_POLICY.READER);
		return `${words.toLocaleString()} words`;
	});

	eleventyConfig.addFilter("rawMarkdown", function (inputPath, title, pageUrl) {
		if (!inputPath) return "";
		try {
			const content = fs.readFileSync(inputPath, "utf-8");
			let withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, "").trim();
			if (title && !withoutFrontmatter.startsWith("# ")) {
				withoutFrontmatter = `# ${title}\n\n${withoutFrontmatter}`;
			}

			const assetOrigin = ASSET_ORIGIN || SITE_URL;
			const cleanPageUrl = pageUrl ? (pageUrl.endsWith("/") ? pageUrl : pageUrl + "/") : "/";
			const postBaseAssetUrl = `${assetOrigin}${cleanPageUrl}`;

			// Transform markdown image syntax: ![alt](src)
			let transformed = withoutFrontmatter.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
				const trimmedSrc = src.trim();
				if (/^https?:\/\//i.test(trimmedSrc)) {
					return match;
				}
				if (trimmedSrc.startsWith("/blog/") || trimmedSrc.startsWith("/raw/")) {
					return `![${alt}](${assetOrigin}${trimmedSrc})`;
				}
				const cleanSrc = trimmedSrc.replace(/^\.\//, "");
				return `![${alt}](${postBaseAssetUrl}${cleanSrc})`;
			});

			// Transform HTML img tag src="..." as well
			transformed = transformed.replace(
				/(<img\s+[^>]*src=["'])([^"']+)(["'][^>]*>)/gi,
				(match, prefix, src, suffix) => {
					const trimmedSrc = src.trim();
					if (/^https?:\/\//i.test(trimmedSrc)) {
						return match;
					}
					if (trimmedSrc.startsWith("/blog/") || trimmedSrc.startsWith("/raw/")) {
						return `${prefix}${assetOrigin}${trimmedSrc}${suffix}`;
					}
					const cleanSrc = trimmedSrc.replace(/^\.\//, "");
					return `${prefix}${postBaseAssetUrl}${cleanSrc}${suffix}`;
				},
			);

			return transformed;
		} catch {
			return "";
		}
	});

	eleventyConfig.addFilter("readableDate", (dateObj, format) => {
		const dt = toSiteDateTime(dateObj);
		return dt ? dt.toFormat(format || "LLL dd, yyyy") : "";
	});

	// Default output: "May 29, 2026 at 22:34 UTC" (abbreviation follows site.timezone).
	eleventyConfig.addFilter("readableDatetime", (dateObj, format) => {
		const dt = toSiteDateTime(dateObj);
		return dt ? dt.toFormat(format || "LLL dd, yyyy 'at' HH:mm ZZZZ") : "";
	});

	// The current year in the site timezone, or the year of a given date.
	eleventyConfig.addFilter("getCurrentYear", (dateInput) => {
		return (dateInput && toSiteDateTime(dateInput)?.year) || siteNow().year;
	});

	// Calendar day in the site timezone (must match readableDate / visible bylines).
	// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-date-string
	eleventyConfig.addFilter("htmlDateString", (dateInput) => {
		const dt = toSiteDateTime(dateInput);
		return dt ? dt.toFormat("yyyy-LL-dd") : "";
	});

	// Newest of (updated || date) across a collection (Atom feed-level <updated>).
	eleventyConfig.addFilter("getNewestCollectionModifiedDate", function getNewestCollectionModifiedDate(collection) {
		let max = 0;
		for (const item of collection || []) {
			const raw = item?.data?.updated ?? item?.date;
			if (raw == null) continue;
			const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
			if (!Number.isNaN(t) && t > max) max = t;
		}
		return max ? new Date(max) : new Date(0);
	});

	eleventyConfig.addFilter("isoDateString", (dateInput) => {
		let dt = toSiteDateTime(dateInput);
		if (dt && typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
			dt = dt.startOf("day");
		}
		if (!dt) {
			console.error(`[isoDateString filter] Failed to parse date: ${dateInput}. Using epoch as fallback.`);
			return DateTime.fromMillis(0, { zone: SITE_ZONE }).toISO({ includeOffset: true, suppressMilliseconds: true });
		}
		// ISO 8601 with timezone offset, no milliseconds
		return dt.toISO({ includeOffset: true, suppressMilliseconds: true });
	});

	eleventyConfig.addFilter("isNoIndex", function (indexVal) {
		if (!indexVal) return false;
		if (Array.isArray(indexVal)) {
			return indexVal.some((item) => typeof item === "string" && item.toLowerCase().includes("noindex"));
		}
		if (typeof indexVal === "string") {
			return indexVal.toLowerCase().includes("noindex");
		}
		return false;
	});

	eleventyConfig.addFilter("head", (array, n) => {
		if (!Array.isArray(array) || array.length === 0) {
			return [];
		}
		if (n < 0) {
			return array.slice(n);
		}

		return array.slice(0, n);
	});

	// Build archive year rail + "All years" map data (recent chips, pin, decades).
	eleventyConfig.addFilter("archiveYearNav", function archiveYearNav(archiveYears, activeYear, recentLimit = 5) {
		const years = Array.isArray(archiveYears) ? archiveYears : [];
		const limit = Number.isFinite(Number(recentLimit)) ? Math.max(1, Number(recentLimit)) : 5;
		const recentYears = years.slice(0, limit);
		const active = activeYear == null ? null : String(activeYear);
		const activeInRecent = recentYears.some((yearGroup) => String(yearGroup.year) === active);
		const pinnedYear = activeInRecent ? null : years.find((yearGroup) => String(yearGroup.year) === active) || null;
		const decadeSet = new Set(years.map((yearGroup) => yearGroup.decade).filter(Boolean));
		const showDecades = decadeSet.size > 1;

		// Flatten decade labels into the map list so the template needs no loop state.
		const mapRows = [];
		let lastDecade = null;
		for (const yearGroup of years) {
			if (showDecades && yearGroup.decade && yearGroup.decade !== lastDecade) {
				mapRows.push({ type: "decade", label: yearGroup.decade });
				lastDecade = yearGroup.decade;
			}
			mapRows.push({
				type: "year",
				year: yearGroup.year,
				totalCount: yearGroup.totalCount,
				fillRatio: yearGroup.fillRatio ?? 0,
				isCurrent: String(yearGroup.year) === active,
			});
		}

		return {
			recentYears,
			pinnedYear,
			showAllTrigger: years.length > limit,
			yearCount: years.length,
			mapRows,
		};
	});

	eleventyConfig.addFilter("min", (...numbers) => {
		return Math.min.apply(null, numbers);
	});

	const excludedTagList = EXCLUDED_TAGS;

	eleventyConfig.addFilter("filterTagList", function filterTagList(tags) {
		return (tags || []).filter((tag) => excludedTagList.indexOf(tag) === -1);
	});

	function isRawNoteItem(item) {
		return Boolean(item?.inputPath && String(item.inputPath).includes("content/raw/"));
	}

	// True when an Eleventy item is a raw note (vs blog post).
	eleventyConfig.addFilter("isRawNote", function isRawNote(item) {
		return isRawNoteItem(item);
	});

	// Which entry kinds appear in a list (used by Keep reading legend).
	// Returns { blog: boolean, note: boolean } so the heading can show only
	// the types present (one or both).
	eleventyConfig.addFilter("entryKindsInList", function entryKindsInList(items) {
		const kinds = { blog: false, note: false };
		if (!Array.isArray(items)) return kinds;
		for (const item of items) {
			if (isRawNoteItem(item)) kinds.note = true;
			else kinds.blog = true;
			if (kinds.blog && kinds.note) break;
		}
		return kinds;
	});

	// Serialize JSON-LD for embedding in <script type="application/ld+json">.
	// Escape "<" so page titles can never break out of the script element.
	eleventyConfig.addFilter("jsonLdString", function jsonLdString(value) {
		if (value == null) return "";
		return JSON.stringify(value).replace(/</g, "\\u003c");
	});

	// Build Schema.org objects for a personal site (Person author, not Organization).
	// kind: "blogPosting" | "home" | "about"
	eleventyConfig.addFilter("buildJsonLd", function buildJsonLd(kind, data = {}) {
		const siteUrl = String(data.siteUrl || SITE_URL).replace(/\/$/, "");
		const personId = `${siteUrl}/#person`;
		const websiteId = `${siteUrl}/#website`;
		const authorName = data.authorName || site.author.name;
		const authorUrl = data.authorUrl || `${siteUrl}/about/`;
		const language = data.language || "en";
		const sameAs = Array.isArray(data.sameAs) ? data.sameAs.filter(Boolean) : [];

		const person = {
			"@type": "Person",
			"@id": personId,
			name: authorName,
			url: authorUrl,
		};
		if (data.authorEmail) person.email = data.authorEmail;
		if (sameAs.length) person.sameAs = sameAs;
		if (data.personDescription) person.description = data.personDescription;

		if (kind === "blogPosting") {
			const pageUrl = data.pageUrl;
			if (!pageUrl || !data.headline) return null;

			const published = data.datePublished || data.dateModified;
			const modified = data.dateModified || data.datePublished;
			const obj = {
				"@context": "https://schema.org",
				"@type": "BlogPosting",
				headline: data.headline,
				url: pageUrl,
				mainEntityOfPage: {
					"@type": "WebPage",
					"@id": pageUrl,
				},
				inLanguage: language,
				author: {
					"@type": "Person",
					"@id": personId,
					name: authorName,
					url: authorUrl,
				},
				// Personal site: publisher is the same Person (valid; no fake Organization).
				publisher: {
					"@type": "Person",
					"@id": personId,
					name: authorName,
					url: authorUrl,
				},
			};
			if (data.description) obj.description = data.description;
			if (published) obj.datePublished = published;
			if (modified) obj.dateModified = modified;
			if (data.image) obj.image = Array.isArray(data.image) ? data.image : [data.image];
			return obj;
		}

		if (kind === "home") {
			const website = {
				"@type": "WebSite",
				"@id": websiteId,
				url: `${siteUrl}/`,
				name: data.siteName || authorName,
				inLanguage: language,
				publisher: { "@id": personId },
				potentialAction: {
					"@type": "SearchAction",
					target: {
						"@type": "EntryPoint",
						urlTemplate: `${siteUrl}/search/?q={search_term_string}`,
					},
					"query-input": "required name=search_term_string",
				},
			};
			if (data.siteDescription) website.description = data.siteDescription;
			return {
				"@context": "https://schema.org",
				"@graph": [website, person],
			};
		}

		if (kind === "about") {
			const aboutUrl = data.pageUrl || authorUrl;
			return {
				"@context": "https://schema.org",
				"@type": "ProfilePage",
				url: aboutUrl,
				name: data.pageName || "About",
				mainEntity: person,
			};
		}

		return null;
	});

	// Content tags only: exclude system collections and empty tag collections.
	eleventyConfig.addFilter("contentTagList", function contentTagList(collections) {
		return Object.keys(collections || {}).filter((tag) => {
			if (excludedTagList.indexOf(tag) !== -1) return false;
			const items = collections[tag];
			// Real tag collections are arrays of page objects (have .url / .inputPath),
			// not arrays of plain strings (like contentTagList itself).
			return Array.isArray(items) && items.length > 0 && items[0] && items[0].url;
		});
	});

	// Get detailed tags list (name, count, latestTimestamp, latestDateFormatted)
	eleventyConfig.addFilter("getAllTagsDetails", function getAllTagsDetails(collections) {
		const tagNames = Object.keys(collections || {}).filter((tag) => {
			if (excludedTagList.indexOf(tag) !== -1) return false;
			const items = collections[tag];
			return Array.isArray(items) && items.length > 0 && items[0] && items[0].url;
		});

		const tagDetails = tagNames.map((tag) => {
			const items = collections[tag] || [];
			let latestMs = 0;

			for (const item of items) {
				const rawDate = item.data?.updated ?? item.date;
				if (rawDate) {
					const t = rawDate instanceof Date ? rawDate.getTime() : new Date(rawDate).getTime();
					if (!Number.isNaN(t) && t > latestMs) {
						latestMs = t;
					}
				}
			}

			const latestDate = latestMs ? new Date(latestMs) : new Date(0);
			const latestDateFormatted = latestMs
				? DateTime.fromJSDate(latestDate, { zone: SITE_ZONE }).toFormat("LLL yyyy")
				: "";

			return {
				name: tag,
				count: items.length,
				latestTimestamp: latestMs,
				latestDateFormatted: latestDateFormatted,
			};
		});

		// Default sort: Popularity (highest count first), then recency, then alphabetical
		return tagDetails.sort((a, b) => {
			if (b.count !== a.count) {
				return b.count - a.count;
			}
			if (b.latestTimestamp !== a.latestTimestamp) {
				return b.latestTimestamp - a.latestTimestamp;
			}
			return a.name.localeCompare(b.name);
		});
	});

	eleventyConfig.addFilter("stripTrailingSlash", function (url) {
		if (!url) return url;
		return url.replace(/\/$/, "");
	});

	eleventyConfig.addFilter("getBookCount", function (books) {
		if (!books || !Array.isArray(books)) return 0;
		return books.length;
	});

	eleventyConfig.addFilter("sortBookmarksByDate", function (bookmarks) {
		if (!bookmarks || !Array.isArray(bookmarks)) return [];
		return [...bookmarks].sort((a, b) => {
			return Date.parse(b.dateAdded || 0) - Date.parse(a.dateAdded || 0);
		});
	});

	eleventyConfig.addFilter("bookmarkDomain", function (url) {
		if (!url) return "";
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return url;
		}
	});

	eleventyConfig.addFilter("formatDateAdded", function (dateStr) {
		const dt = toSiteDateTime(dateStr);
		return dt ? dt.toFormat("LLL dd, yyyy") : "";
	});

	// "https://umami.example.com/script.js" -> "https://umami.example.com"
	eleventyConfig.addFilter("urlOrigin", function (url) {
		try {
			return new URL(url).origin;
		} catch {
			return "";
		}
	});

	// "https://mastodon.social" -> "mastodon.social"
	eleventyConfig.addFilter("urlHost", function (url) {
		try {
			return new URL(url).host;
		} catch {
			return "";
		}
	});

	eleventyConfig.addFilter("toLocaleString", function (number, locale = site.locale || "en-US") {
		return Number(number ?? 0).toLocaleString(locale);
	});

	// Fix relative URLs in content (for archive pages)
	eleventyConfig.addFilter("absoluteUrls", function (content, postUrl) {
		if (!content || !postUrl) return content;
		// Match src="./..." or src="./" patterns and replace with absolute path
		return content.replace(/src="\.\/([^"]+)"/g, (match, filename) => {
			return `src="${postUrl}${filename}"`;
		});
	});

	/**
	 * Sliding pagination window with ellipsis.
	 * Input: Eleventy pagination object (0-based pageNumber).
	 * Output: [{ type: "page", number, href, current }, { type: "ellipsis" }, ...]
	 * Always keeps first + last; shows `siblings` pages on each side of current.
	 * Single-page gaps are filled instead of showing an ellipsis.
	 */
	eleventyConfig.addFilter("paginationWindow", function (pagination, siblings = 1) {
		if (!pagination?.pages?.length || !pagination.hrefs) return [];

		const total = pagination.pages.length;
		const current = pagination.pageNumber;
		const hrefs = pagination.hrefs;
		const side = Math.max(0, Number(siblings) || 0);

		const pageItem = (index) => ({
			type: "page",
			number: index + 1,
			href: hrefs[index],
			current: index === current,
		});

		// Small enough to list every page without ellipsis
		const maxWithoutEllipsis = side * 2 + 5;
		if (total <= maxWithoutEllipsis) {
			return Array.from({ length: total }, (_, i) => pageItem(i));
		}

		const show = new Set([0, total - 1]);
		for (let i = current - side; i <= current + side; i++) {
			if (i >= 0 && i < total) show.add(i);
		}

		const sorted = [...show].sort((a, b) => a - b);
		const result = [];

		for (let i = 0; i < sorted.length; i++) {
			const index = sorted[i];
			if (i > 0) {
				const prev = sorted[i - 1];
				const gap = index - prev;
				if (gap === 2) {
					result.push(pageItem(prev + 1));
				} else if (gap > 2) {
					result.push({ type: "ellipsis" });
				}
			}
			result.push(pageItem(index));
		}

		return result;
	});
}
