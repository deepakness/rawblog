import EleventyFetch from "@11ty/eleventy-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import site from "../../_config/site.js";
import { siteNow } from "../../_config/time.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CACHE_DIR = path.join(ROOT_DIR, ".cache");
const FALLBACK_CACHE_FILE = path.join(CACHE_DIR, "github-contributions-fallback.json");
const ACTIVITY_CACHE_FILE = path.join(CACHE_DIR, "github-activity-fallback.json");

const DEFAULT_USERNAME = site.githubUsername || "";
const DEFAULT_CACHE_DURATION = "2m";

/**
 * Reads persistent fallback cache from disk.
 * @returns {Record<string, number | string>} Map of cache keys to values
 */
function loadFallbackCache() {
	try {
		if (fs.existsSync(FALLBACK_CACHE_FILE)) {
			return JSON.parse(fs.readFileSync(FALLBACK_CACHE_FILE, "utf-8"));
		}
	} catch (err) {
		console.warn(`[GitHub Contributions] Failed to read fallback cache: ${err.message}`);
	}
	return {};
}

/**
 * Saves non-zero contribution values to persistent fallback cache on disk.
 * @param {string} key
 * @param {number} value
 */
function saveFallbackCache(key, value) {
	if (typeof value !== "number" || value <= 0) return;
	try {
		if (!fs.existsSync(CACHE_DIR)) {
			fs.mkdirSync(CACHE_DIR, { recursive: true });
		}
		const cache = loadFallbackCache();
		cache[key] = value;
		cache[`${key}_updatedAt`] = new Date().toISOString();
		fs.writeFileSync(FALLBACK_CACHE_FILE, JSON.stringify(cache, null, "\t"));
	} catch (err) {
		console.warn(`[GitHub Contributions] Failed to write fallback cache: ${err.message}`);
	}
}

/**
 * Fetches contributions directly from GitHub's user contributions HTML page.
 * @param {boolean} isCurrentYear
 * @param {string} username
 * @param {string} duration
 * @returns {Promise<number | null>}
 */
async function fetchFromGithubDirect(isCurrentYear, username, duration) {
	const currentYear = siteNow().year;
	let url = `https://github.com/users/${username}/contributions`;
	if (isCurrentYear) {
		url += `?from=${currentYear}-01-01&to=${currentYear}-12-31`;
	}

	try {
		const html = await EleventyFetch(url, {
			duration,
			type: "text",
			directory: ".cache/eleventy-fetch/",
		});

		const match = html.match(/([\d,]+)\s+contributions\s+in/i);
		if (match) {
			const count = parseInt(match[1].replace(/,/g, ""), 10);
			if (!isNaN(count) && count > 0) {
				return count;
			}
		}
	} catch (error) {
		console.warn(`[GitHub Contributions] GitHub Direct fetch failed: ${error.message}`);
	}
	return null;
}

/**
 * Fetches contributions from jogruber API service.
 * @param {boolean} isCurrentYear
 * @param {string} username
 * @param {string} duration
 * @returns {Promise<number | null>}
 */
async function fetchFromJogruberApi(isCurrentYear, username, duration) {
	const currentYear = String(siteNow().year);
	const url = `https://github-contributions-api.jogruber.de/v4/${username}`;

	try {
		const data = await EleventyFetch(url, {
			duration,
			type: "json",
			directory: ".cache/eleventy-fetch/",
		});

		if (isCurrentYear) {
			const count = Number(data?.total?.[currentYear]);
			if (!isNaN(count) && count > 0) return count;
		} else {
			const past365Days = new Date();
			past365Days.setDate(new Date().getDate() - 365);
			const contributions = data?.contributions || [];
			const count = contributions
				.filter((c) => new Date(c.date) >= past365Days)
				.reduce((sum, c) => sum + (Number(c.count) || 0), 0);
			if (count > 0) return count;
		}
	} catch (error) {
		console.warn(`[GitHub Contributions] Jogruber API fetch failed: ${error.message}`);
	}
	return null;
}

/**
 * Fetches GitHub contributions for a username with multi-tiered fallbacks.
 *
 * @param {Object} options
 * @param {boolean} [options.isCurrentYear=false] Whether to filter for the current calendar year.
 * @param {string} [options.username=site.githubUsername] GitHub username.
 * @param {string} [options.duration='2m'] EleventyFetch cache duration.
 * @returns {Promise<number>} Total contributions count.
 */
export async function fetchGithubContributions({
	isCurrentYear = false,
	username = DEFAULT_USERNAME,
	duration = DEFAULT_CACHE_DURATION,
} = {}) {
	const currentYear = siteNow().year;
	const cacheKey = isCurrentYear ? `year_${currentYear}` : "last365";

	// Tier 1: Direct GitHub HTML scraping
	const directCount = await fetchFromGithubDirect(isCurrentYear, username, duration);
	if (directCount !== null && directCount > 0) {
		saveFallbackCache(cacheKey, directCount);
		return directCount;
	}

	// Tier 2: Jogruber API fallback
	const jogruberCount = await fetchFromJogruberApi(isCurrentYear, username, duration);
	if (jogruberCount !== null && jogruberCount > 0) {
		saveFallbackCache(cacheKey, jogruberCount);
		return jogruberCount;
	}

	// Tier 3: Read last known good non-zero value from disk snapshot
	const fallbackCache = loadFallbackCache();
	if (typeof fallbackCache[cacheKey] === "number" && fallbackCache[cacheKey] > 0) {
		console.log(
			`[GitHub Contributions] Using last-known-good disk fallback for ${cacheKey}: ${fallbackCache[cacheKey]}`,
		);
		return fallbackCache[cacheKey];
	}

	return 0;
}

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Fetches the last 365 days of daily contribution counts.
 * Only jogruber exposes a per-day series; GitHub's HTML page is scraped for
 * totals elsewhere and is not a usable source here.
 * @param {string} username
 * @param {string} duration
 * @returns {Promise<Array<{date: string, count: number}> | null>}
 */
async function fetchDailySeries(username, duration) {
	const url = `https://github-contributions-api.jogruber.de/v4/${username}?y=last`;

	try {
		const data = await EleventyFetch(url, {
			duration,
			type: "json",
			directory: ".cache/eleventy-fetch/",
		});

		const series = (data?.contributions || [])
			.map((c) => ({ date: String(c.date), count: Number(c.count) || 0 }))
			.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date));

		// A short series means a partial or malformed response, not a quiet year
		if (series.length >= 300) return series;
	} catch (error) {
		console.warn(`[GitHub Contributions] Daily series fetch failed: ${error.message}`);
	}
	return null;
}

/**
 * Buckets a daily series into Sunday-first weeks.
 *
 * Partial weeks at either end are dropped. A window of exactly 365 days almost
 * always ends mid-week, and a two-day week charted beside seven-day ones reads
 * as a sudden collapse rather than as an incomplete bucket.
 *
 * @param {Array<{date: string, count: number}>} series
 * @returns {Array<{total: number, days: number, start: string}>}
 */
function weeklyTotals(series) {
	const weeks = [];
	series.forEach((day, index) => {
		const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
		if (weekday === 0 || index === 0) weeks.push({ total: 0, days: 0, start: day.date });
		const week = weeks[weeks.length - 1];
		week.total += day.count;
		week.days++;
	});
	// Only whole weeks: a partial first or last week would draw a false dip.
	return weeks.filter((week) => week.days === 7);
}

/**
 * Whole-week totals with a 0–100 height, so a template can draw a bar chart of
 * the same series the sparkline summarises.
 * @param {Array<{date: string, count: number}>} series
 * @returns {Array<{total: number, start: string, label: string, pct: number}>}
 */
function buildWeekBars(series) {
	const weeks = weeklyTotals(series);
	const peak = Math.max(1, ...weeks.map((w) => w.total));
	return weeks.map((week) => ({
		total: week.total,
		start: week.start,
		label: formatFullDate(week.start),
		pct: Math.max(2, Math.round((week.total / peak) * 1000) / 10),
	}));
}

/**
 * Renders one block character per whole week, scaled against the busiest week.
 * @param {Array<{date: string, count: number}>} series
 * @returns {string}
 */
function buildSparkline(series) {
	const complete = weeklyTotals(series).map((week) => week.total);
	if (!complete.length) return "";

	const peak = Math.max(...complete);
	if (peak <= 0) return SPARK_BLOCKS[0].repeat(complete.length);

	return complete
		.map((total) => SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, Math.floor((total / peak) * SPARK_BLOCKS.length))])
		.join("");
}

/**
 * Formats an ISO date as "Aug 2025".
 * @param {string} isoDate
 * @returns {string}
 */
function formatMonthYear(isoDate) {
	const date = new Date(`${isoDate}T00:00:00Z`);
	return `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Formats an ISO date as "Aug 08, 2026", matching the site's readableDate
 * filter. That filter only parses full timestamps, so plain day strings from
 * the API are formatted here instead.
 * @param {string} isoDate
 * @returns {string}
 */
function formatFullDate(isoDate) {
	const date = new Date(`${isoDate}T00:00:00Z`);
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${SHORT_MONTHS[date.getUTCMonth()]} ${day}, ${date.getUTCFullYear()}`;
}

/**
 * Derives the display stats shown in the terminal card on /about.
 * @param {Array<{date: string, count: number}>} series
 * @returns {Object}
 */
function summarize(series) {
	const total = series.reduce((sum, day) => sum + day.count, 0);
	const activeDays = series.filter((day) => day.count > 0).length;

	let bestStreak = 0;
	let run = 0;
	for (const day of series) {
		run = day.count > 0 ? run + 1 : 0;
		if (run > bestStreak) bestStreak = run;
	}

	let currentStreak = 0;
	for (let i = series.length - 1; i >= 0; i--) {
		if (series[i].count === 0) break;
		currentStreak++;
	}

	const busiest = series.reduce((best, day) => (day.count > best.count ? day : best), series[0]);

	return {
		total,
		activeDays,
		totalDays: series.length,
		currentStreak,
		bestStreak,
		busiestCount: busiest.count,
		busiestDate: busiest.date,
		busiestLabel: formatFullDate(busiest.date),
		sparkline: buildSparkline(series),
		weekBars: buildWeekBars(series),
		avgPerActiveDay: activeDays ? Math.round((total / activeDays) * 10) / 10 : 0,
		startLabel: formatMonthYear(series[0].date),
		endLabel: formatMonthYear(series[series.length - 1].date),
	};
}

/**
 * Fetches a year of daily GitHub activity and reduces it to the summary the
 * /about terminal card renders. Falls back to the last good summary on disk so
 * a flaky upstream never blanks the card.
 *
 * @param {Object} options
 * @param {string} [options.username=site.githubUsername] GitHub username.
 * @param {string} [options.duration='2m'] EleventyFetch cache duration.
 * @returns {Promise<Object | null>} Summary object, or null if nothing is available.
 */
export async function fetchGithubActivity({ username = DEFAULT_USERNAME, duration = DEFAULT_CACHE_DURATION } = {}) {
	const series = await fetchDailySeries(username, duration);

	if (series) {
		const summary = summarize(series);
		try {
			if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
			fs.writeFileSync(
				ACTIVITY_CACHE_FILE,
				JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2),
			);
		} catch (err) {
			console.warn(`[GitHub Contributions] Failed to write activity cache: ${err.message}`);
		}
		return summary;
	}

	try {
		if (fs.existsSync(ACTIVITY_CACHE_FILE)) {
			const cached = JSON.parse(fs.readFileSync(ACTIVITY_CACHE_FILE, "utf-8"));
			if (cached?.total > 0) {
				console.log(`[GitHub Contributions] Using last-known-good activity snapshot from ${cached.updatedAt}`);
				return cached;
			}
		}
	} catch (err) {
		console.warn(`[GitHub Contributions] Failed to read activity cache: ${err.message}`);
	}

	return null;
}
