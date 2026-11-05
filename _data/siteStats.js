/**
 * Site-wide statistics, the single source for every figure on the footer,
 * /about, and /stats.
 *
 * Everything is derived from the posts, notes, and the standalone pages listed
 * in _config/wordCountPages.js, using the same word and image counters as the
 * rest of the site (countWordsInFile / countImagesInFile in _config/filters.js).
 * Dates are grouped in the site timezone, matching the archive.
 */
import fs from "fs";
import path from "path";
import { DateTime } from "luxon";
import { countWordsInFile, countImagesInFile, WORD_POLICY } from "../_config/filters.js";
import { WORD_COUNT_PAGES } from "../_config/wordCountPages.js";
import { isDraftData } from "../_config/drafts.js";
import { siteNow, toSiteDateTime } from "../_config/time.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Publishing hours collapse into six 4-hour bands: 24 separate bars are noise at
// this sample size, and the bands are what a reader actually takes away.
const HOUR_BANDS = [
	{ label: "00–04", from: 0, to: 4 },
	{ label: "04–08", from: 4, to: 8 },
	{ label: "08–12", from: 8, to: 12 },
	{ label: "12–16", from: 12, to: 16 },
	{ label: "16–20", from: 16, to: 20 },
	{ label: "20–24", from: 20, to: 24 },
];

/** Every content/blog/<slug>/index.md and content/raw/<slug>/index.md on disk. */
function entryFiles() {
	const files = [];
	for (const root of ["content/blog", "content/raw"]) {
		if (!fs.existsSync(root)) continue;
		for (const slug of fs.readdirSync(root)) {
			const p = path.join(root, slug, "index.md");
			if (fs.existsSync(p)) files.push(p);
		}
	}
	return files;
}

/** Split a file into frontmatter block, parsed scalar fields, and body. */
function parseFrontmatter(filePath) {
	const content = fs.readFileSync(filePath, "utf-8");
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return { content, data: {}, body: content, block: "" };

	const block = match[1];
	const data = {};
	for (const line of block.split("\n")) {
		const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (!m) continue;
		let val = m[2].trim();
		if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
			val = val.slice(1, -1).replace(/\\(["'])/g, "$1");
		}
		data[m[1]] = val;
	}

	return { content, data, body: content.slice(match[0].length), block };
}

/** Tags from the frontmatter block: [a, b], a - list items, or a single scalar. */
function extractTags(block) {
	const inline = block.match(/^tags:\s*\[(.*?)\]\s*$/m);
	if (inline) {
		return inline[1]
			.split(",")
			.map((s) => s.trim().replace(/^(["'])|(["'])$/g, ""))
			.filter(Boolean);
	}
	const list = block.match(/^tags:\s*\n((?:^\s*-\s*.*\n?)+)/m);
	if (list) {
		return list[1]
			.split("\n")
			.map((l) =>
				l
					.trim()
					.replace(/^-\s*/, "")
					.replace(/^(["'])|(["'])$/g, ""),
			)
			.filter(Boolean);
	}
	const single = block.match(/^tags:\s*(.+)$/m);
	if (single) {
		return single[1]
			.split(/[,\s]+/)
			.map((s) => s.trim().replace(/^(["'])|(["'])$/g, ""))
			.filter(Boolean);
	}
	return [];
}

function parseDate(raw) {
	return raw ? toSiteDateTime(String(raw)) : null;
}

/** Count fenced code blocks and total interior lines in a body. */
function countCode(body) {
	const fences = body.match(/```[\s\S]*?```/g) || [];
	let lines = 0;
	for (const block of fences) lines += block.split("\n").length - 2; // minus both fence lines
	return { blocks: fences.length, lines };
}

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export default function ({ now: injectedNow } = {}) {
	// One clock for the whole computation. Injectable so the year-rollover and
	// empty-corpus paths can be exercised without waiting for the calendar.
	const now = injectedNow ? injectedNow.setZone(siteNow().zone) : siteNow();
	const files = entryFiles();
	const tagCounts = new Map();
	const weekdays = Array(7).fill(0);
	const hours = Array(24).fill(0);
	const monthMap = new Map(); // "yyyy-LL" -> { key, year, month, blog, note }
	const monthKeysSet = new Set();
	const yearWords = new Map(); // "yyyy" -> words published that year
	const entryDates = []; // every published date, for gap and year-to-date maths

	const lengths = [];
	let wordsBlog = 0;
	let wordsRaw = 0;
	let imagesTotal = 0;
	let codeBlocks = 0;
	let codeLines = 0;
	let postsWithCode = 0;
	let postsWithImages = 0;
	let videoPosts = 0;
	let mastodonPosts = 0;
	let affiliatePosts = 0;
	let updatedPosts = 0;
	let updatedDaysSum = 0;
	let postCount = 0;
	let noteCount = 0;
	let tagAssignments = 0;
	let firstEntry = null;
	let latestEntry = null;
	let longest = null;
	let shortest = null;
	let longestTitle = null;

	for (const filePath of files) {
		const { data, body, block } = parseFrontmatter(filePath);
		if (isDraftData(data)) continue;

		const isNote = filePath.startsWith("content/raw/");
		const dt = parseDate(data.date);
		if (!dt) continue;

		const slug = path.basename(path.dirname(filePath));
		const url = `${isNote ? "/raw/" : "/blog/"}${slug}/`;
		const title = data.title || slug;
		const words = countWordsInFile(filePath);
		// Extremes link straight to the entry, so they quote the same figure the
		// entry's own page shows rather than the archive one.
		const readerWords = countWordsInFile(filePath, WORD_POLICY.READER);

		if (isNote) {
			noteCount += 1;
			wordsRaw += words;
		} else {
			postCount += 1;
			wordsBlog += words;
		}
		lengths.push(words);

		if (!firstEntry || dt < firstEntry.date) firstEntry = { title, url, date: dt };
		if (!latestEntry || dt > latestEntry.date) latestEntry = { title, url, date: dt };

		const images = countImagesInFile(filePath);
		imagesTotal += images;
		if (images > 0) postsWithImages += 1;

		if (/\{%\s*video\b/.test(body)) videoPosts += 1;
		if (data.mastodon) mastodonPosts += 1;
		if (data.affiliate === "true") affiliatePosts += 1;
		if (data.updated) {
			updatedPosts += 1;
			const updatedDt = parseDate(data.updated);
			if (updatedDt) {
				updatedDaysSum += Math.max(0, Math.round(updatedDt.diff(dt, "days").days));
			}
		}

		const code = countCode(body);
		codeBlocks += code.blocks;
		codeLines += code.lines;
		if (code.blocks > 0) postsWithCode += 1;

		weekdays[dt.weekday - 1] += 1;
		hours[dt.hour] += 1;

		const tags = extractTags(block);
		tagAssignments += tags.length;
		for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);

		const monthKey = dt.toFormat("yyyy-LL");
		if (!monthMap.has(monthKey)) {
			monthMap.set(monthKey, { key: monthKey, year: dt.toFormat("yyyy"), month: dt.month, blog: 0, note: 0, count: 0 });
		}
		const monthGroup = monthMap.get(monthKey);
		monthGroup.count += 1;
		if (isNote) monthGroup.note += 1;
		else monthGroup.blog += 1;
		monthKeysSet.add(monthKey);

		const yearKey = dt.toFormat("yyyy");
		yearWords.set(yearKey, (yearWords.get(yearKey) || 0) + words);
		entryDates.push({ ts: dt.toMillis(), year: yearKey, ordinal: dt.ordinal, isNote });

		if (!longest || readerWords > longest.words) longest = { title, url, words: readerWords };
		if (!shortest || readerWords < shortest.words) shortest = { title, url, words: readerWords };
		if (!longestTitle || title.length > longestTitle.chars)
			longestTitle = { title, url, chars: title.length, words: readerWords };
	}

	// Consecutive-month streaks over the whole writing life.
	const sortedMonthKeys = [...monthKeysSet].sort();
	let longestStreak = 0;
	let run = 0;
	let prevMonth = null;
	for (const key of sortedMonthKeys) {
		const [y, m] = key.split("-").map(Number);
		if (prevMonth) {
			const contiguous =
				(y === prevMonth.y && m === prevMonth.m + 1) || (y === prevMonth.y + 1 && prevMonth.m === 12 && m === 1);
			run = contiguous ? run + 1 : 1;
		} else {
			run = 1;
		}
		prevMonth = { y, m };
		longestStreak = Math.max(longestStreak, run);
	}
	// Current streak: count back from the latest month to the first gap.
	let currentStreak = 1;
	for (let i = sortedMonthKeys.length - 1; i >= 1; i--) {
		const [cy, cm] = sortedMonthKeys[i].split("-").map(Number);
		const [py, pm] = sortedMonthKeys[i - 1].split("-").map(Number);
		if ((cy === py && cm === pm + 1) || (cy === py + 1 && pm === 12 && cm === 1)) currentStreak += 1;
		else break;
	}

	// Heat scale: quintiles of the months that actually have entries, not fixed
	// buckets, so the colours stay spread out whether a busy month has 5 entries or 50.
	const activeCounts = [...monthMap.values()].map((m) => m.count).sort((a, b) => a - b);
	const quantile = (p) => activeCounts[Math.min(activeCounts.length - 1, Math.floor(activeCounts.length * p))];
	const cuts = [...new Set([quantile(0.2), quantile(0.4), quantile(0.6), quantile(0.8)])].filter(
		(c) => c < activeCounts[activeCounts.length - 1],
	);
	// A month's level is how many cut points it clears, so levels stay 1..cuts+1.
	const heatLevel = (count) => (count === 0 ? 0 : 1 + cuts.filter((cut) => count > cut).length);
	const heatLegend = cuts.map((cut, i) => {
		const from = i === 0 ? Math.min(...activeCounts) : cuts[i - 1] + 1;
		return { level: i + 1, label: from === cut ? `${cut}` : `${from}–${cut}` };
	});
	const lastCut = cuts[cuts.length - 1];
	heatLegend.push({
		level: cuts.length + 1,
		label: `${lastCut === undefined ? (activeCounts[0] ?? 1) : lastCut + 1}+`,
	});

	// Calendar matrix: years (newest first) × Jan..Dec so the template does no math.
	// The current year is always present even before it has its first entry, so
	// the newest row is always the year the reader is actually in. Without this,
	// every "this year" figure on the page would keep pointing at the last year
	// that happened to have entries once a new year turned over.
	const thisYear = now.toFormat("yyyy");
	// Every year from the first entry to the current one, including any with no
	// entries at all. Listing only the years that have entries would close the
	// gaps and make a silent year look like it never existed.
	const firstYear = firstEntry ? Number(firstEntry.date.toFormat("yyyy")) : Number(thisYear);
	const years = [];
	for (let y = Number(thisYear); y >= firstYear; y--) years.push(String(y));
	const calendar = years.map((year) => {
		const months = MONTHS.map((short, i) => {
			const key = `${year}-${String(i + 1).padStart(2, "0")}`;
			const g = monthMap.get(key) || { key, year, month: i + 1, blog: 0, note: 0, count: 0 };
			// The archive year page anchors each month as "#yyyy-LL", so a heatmap
			// cell can link straight to the entries it counts.
			return { ...g, short, anchor: `/archive/${year}/#${key}`, level: heatLevel(g.count) };
		});
		const totalCount = months.reduce((sum, m) => sum + m.count, 0);
		return { year, totalCount, months };
	});

	// One row per year, richest-first, with the numbers the table needs already
	// resolved: posts, notes, words, and a 0–100 width so the template can draw
	// a volume bar without knowing the maximum.
	const maxYearCount = Math.max(1, ...calendar.map((y) => y.totalCount));
	const yearRows = calendar.map((y) => {
		const blog = y.months.reduce((sum, m) => sum + m.blog, 0);
		const note = y.months.reduce((sum, m) => sum + m.note, 0);
		return {
			year: y.year,
			blog,
			note,
			total: y.totalCount,
			words: yearWords.get(y.year) || 0,
			barBlog: Math.round((blog / maxYearCount) * 1000) / 10,
			barNote: Math.round((note / maxYearCount) * 1000) / 10,
		};
	});

	// The year in progress is partial, so it is never the "best year" claim.
	const completedYears = yearRows.filter((y) => y.year !== thisYear);
	const bestYear = completedYears.length ? completedYears.reduce((a, b) => (b.total > a.total ? b : a)) : null;

	// Mon..Sun in calendar order (not sorted by count) so the shape reads as a week.
	const maxWeekday = Math.max(1, ...weekdays);
	const weekdayBars = WEEKDAYS_SHORT.map((label, i) => ({
		label,
		count: weekdays[i],
		pct: Math.round((weekdays[i] / maxWeekday) * 1000) / 10,
	}));

	const hourBandCounts = HOUR_BANDS.map((band) => ({
		label: band.label,
		count: hours.slice(band.from, band.to).reduce((a, b) => a + b, 0),
	}));
	const maxHourBand = Math.max(1, ...hourBandCounts.map((b) => b.count));
	const hourBars = hourBandCounts.map((b) => ({ ...b, pct: Math.round((b.count / maxHourBand) * 1000) / 10 }));

	const busy = [...monthMap.values()].sort((a, b) => b.count - a.count)[0];

	// Standalone pages are words written for this site too, so the sitewide total counts them.
	let wordsPages = 0;
	let imagesPages = 0;
	for (const pagePath of WORD_COUNT_PAGES) {
		wordsPages += countWordsInFile(pagePath);
		imagesPages += countImagesInFile(pagePath);
	}

	const entryCount = postCount + noteCount;
	const firstTs = firstEntry?.date.toMillis() || 0;
	const latestTs = latestEntry?.date.toMillis() || 0;
	const daysSinceFirst = firstTs ? Math.max(0, Math.round(now.diff(DateTime.fromMillis(firstTs), "days").days)) : 0;
	const avgDaysBetween = entryCount > 1 && firstTs ? (latestTs - firstTs) / 86400000 / (entryCount - 1) : 0;

	// Gaps: the longest silence between two consecutive entries, and how long it
	// has been since the most recent one. A pace average hides both.
	const sortedTs = entryDates.map((e) => e.ts).sort((a, b) => a - b);
	let longestGap = 0;
	for (let i = 1; i < sortedTs.length; i++) {
		longestGap = Math.max(longestGap, Math.round((sortedTs[i] - sortedTs[i - 1]) / 86400000));
	}

	// Year to date against the same stretch of last year: comparing a partial
	// year to a whole one would always read as a collapse.
	const lastYear = String(Number(thisYear) - 1);
	const dayOfYear = now.ordinal;
	const thisYearToDate = entryDates.filter((e) => e.year === thisYear).length;
	const lastYearToDate = entryDates.filter((e) => e.year === lastYear && e.ordinal <= dayOfYear).length;
	const paceThisYear = thisYearToDate > 1 ? (dayOfYear / thisYearToDate).toFixed(1) : null;

	// Archive total (posts + notes) and the sitewide total that also carries the
	// standalone pages. The footer, /about and the /stats hero
	// all quote wordsAll; the archive panels quote wordsTotal.
	const totalWords = wordsBlog + wordsRaw;
	const wordsAll = totalWords + wordsPages;
	const imagesAll = imagesTotal + imagesPages;
	const readingMinutes = wordsAll / 200; // 200 WPM, same as the readingTimeMinutes filter
	const readingLabel =
		readingMinutes >= 60
			? `≈ ${Math.round(readingMinutes / 60)} hours`
			: `≈ ${Math.max(1, Math.round(readingMinutes))} minutes`;

	const singleUseTags = [...tagCounts.values()].filter((c) => c === 1).length;

	// Footer year-progress bar: how much of the current year has elapsed.
	// The 20-character bar string is decorative; the percentage is the real
	// content. Clamped so a fresh year (or leap-day edge) can never produce
	// a negative or over-long bar.
	const daysInYear = now.daysInYear;
	const yearProgressPct = Math.round((dayOfYear / daysInYear) * 100);
	const yearProgressFilled = Math.max(0, Math.min(20, Math.round((dayOfYear / daysInYear) * 20)));
	const yearProgress = {
		year: thisYear,
		pct: yearProgressPct,
		fill: "▓".repeat(yearProgressFilled),
		empty: "▒".repeat(20 - yearProgressFilled),
	};

	return {
		totals: {
			posts: postCount,
			notes: noteCount,
			entries: entryCount,
			wordsBlog,
			wordsRaw,
			wordsTotal: totalWords,
			wordsPages,
			wordsAll,
			pageCount: WORD_COUNT_PAGES.length,
			images: imagesTotal,
			imagesAll,
			postsWithImages,
			codeBlocks,
			codeLines,
			postsWithCode,
			videoPosts,
			mastodonPosts,
			affiliatePosts,
		},
		averages: {
			wordsPerPost: postCount ? Math.round(wordsBlog / postCount) : 0,
			wordsPerNote: noteCount ? Math.round(wordsRaw / noteCount) : 0,
			codeSharePct: entryCount ? Math.round((postsWithCode / entryCount) * 100) : 0,
		},
		tags: {
			distinct: tagCounts.size,
			singleUse: singleUseTags,
			assignments: tagAssignments,
			avgPerEntry: entryCount ? Math.round((tagAssignments / entryCount) * 10) / 10 : 0,
		},
		first: firstEntry
			? { title: firstEntry.title, url: firstEntry.url, date: firstEntry.date.toFormat("LLLL d, yyyy") }
			: null,
		latest: latestEntry
			? {
					title: latestEntry.title,
					url: latestEntry.url,
					date: latestEntry.date.toFormat("LLLL d, yyyy"),
					dateShort: latestEntry.date.toFormat("LLL d, yyyy"),
				}
			: null,
		// Every figure below is measured against this moment. The site only
		// rebuilds when something is published, so without stating the date any
		// "days ago" style number silently ages into a lie between builds.
		builtOn: now.toFormat("d LLLL yyyy"),
		gaps: { longestDays: longestGap },
		yearToDate: {
			year: thisYear,
			entries: thisYearToDate,
			lastYearEntries: lastYearToDate,
			lastYear,
			pace: paceThisYear,
		},
		yearProgress,
		heatLegend,
		daysSinceFirst,
		avgDaysBetween: avgDaysBetween ? avgDaysBetween.toFixed(1) : 0,
		readingLabel,
		extremes: {
			longest,
			shortest,
			longestTitle,
			medianWords: median(lengths),
		},
		streaks: { current: currentStreak, longest: longestStreak },
		busiestMonth: busy ? `${MONTHS[busy.month - 1]} ${busy.year} (${busy.count})` : null,
		bestYear,
		yearRows,
		weekdayBars,
		hourBars,
		weekdays: WEEKDAYS.map((label, i) => ({ label, count: weekdays[i] })).sort((a, b) => b.count - a.count),
		topHours: hours
			.map((count, i) => ({ hour: i, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 3)
			.map((h) => `${String(h.hour).padStart(2, "0")}:00`),
		freshness: {
			updatedCount: updatedPosts,
			avgDaysToUpdate: updatedPosts ? Math.round(updatedDaysSum / updatedPosts) : 0,
		},
		calendar,
	};
}
