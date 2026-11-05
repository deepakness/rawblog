import fs from "fs";

/**
 * Standalone pages whose words are included in sitewide totals (footer / about).
 *
 * Add a path here when you create a new written page you want counted.
 * Paths are relative to the project root.
 *
 * Include: essay-like or hub pages with prose you wrote.
 * Skip: pure indexes (blog/raw/archive/tags), JSON/XML feeds, search shells,
 * and data-only UIs (books/bookmarks lists) — their rows live in _data
 * or in collections already counted elsewhere.
 *
 * CSS, JS, HTML tags, and Nunjucks are stripped before counting (see filters.js).
 */
export const WORD_COUNT_PAGES = [
	"content/about.njk",
	"content/now.njk",
	"content/colophon.md",
	"content/privacy.md",
	"content/feed.md",
	"content/projects.njk",
];

/**
 * Pages deliberately left out of the totals: pure indexes, feeds, search shells,
 * and data-driven UIs whose rows live in _data or in collections already counted.
 *
 * Listed rather than inferred so that a genuinely new written page shows up as a
 * warning instead of silently going uncounted.
 */
export const WORD_COUNT_SKIP_PAGES = [
	"content/404.njk",
	"content/archive-year.njk",
	"content/archive.njk",
	"content/blog.njk",
	"content/blogroll.njk",
	"content/blogroll.opml.njk",
	"content/bookmarks-index.njk",
	"content/bookmarks.njk",
	"content/books.njk",
	"content/changelog.njk",
	"content/index.njk",
	"content/raw-notes.xml.njk",
	"content/raw.njk",
	"content/robots.txt.njk",
	"content/search-index-blog.njk",
	"content/search-index-raw.njk",
	"content/search.njk",
	"content/sitemap.xml.njk",
	"content/stats.njk",
	"content/tag-pages.njk",
	"content/tags.njk",
];

/**
 * Warn once per build about a top-level page that is in neither list.
 *
 * The allowlist stays manual on purpose – globbing every page would sweep in
 * index shells and feeds – but a manual list quietly goes stale, so the build
 * says so rather than letting a new essay page never reach the totals.
 */
export function warnAboutUncountedPages() {
	const known = new Set([...WORD_COUNT_PAGES, ...WORD_COUNT_SKIP_PAGES]);

	let entries;
	try {
		entries = fs.readdirSync("content", { withFileTypes: true });
	} catch {
		return;
	}

	const missing = entries
		.filter((e) => e.isFile() && /\.(njk|md|html)$/.test(e.name))
		.map((e) => `content/${e.name}`)
		.filter((p) => !known.has(p));

	if (missing.length) {
		console.warn(
			`[word count] ${missing.length} page(s) counted nowhere: ${missing.join(", ")}\n` +
				`             Add each to WORD_COUNT_PAGES or WORD_COUNT_SKIP_PAGES in _config/wordCountPages.js.`,
		);
	}
}
