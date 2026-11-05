import { excludedTagSet } from "./excludedTags.js";
import { SITE_HOST } from "./site.js";

/**
 * Related-entry scoring for the "Keep reading" block.
 *
 * Built once per build as a collection (not a per-page filter) so the whole
 * corpus is scored in one pass and the result is a plain lookup by URL.
 *
 * Score is a weighted sum rather than a sort-key cascade, so a tag that sits on
 * many entries doesn't make every candidate tie and fall back to "newest wins".
 * IDF weighting plus a text signal handles that.
 */

// Hand-tuned weights. Text outranks tags because entries with a single tag say
// little about what they share.
const WEIGHTS = {
	tags: 1.0,
	text: 1.6,
	link: 1.2,
	recency: 0.25,
	sameType: 0.08,
};

const LIMIT = 5;
// Below this a match is noise; better to show four good items than five.
const SCORE_FLOOR = 0.3;
// Body text beyond this adds little and costs tokenising time.
const BODY_CHARS = 1500;
// Field weights feeding the TF-IDF vector.
const FIELD_WEIGHTS = { title: 3, description: 2, body: 1 };
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
// Recency halves the score contribution roughly every 4 years, never zeroes it.
const RECENCY_HALFLIFE_YEARS = 4;

const STOP_WORDS = new Set(
	(
		"a an the and or but if then than that this these those is are was were be been being of to in " +
		"on for with without from by as at it its i my me we our you your he she they them not no so " +
		"just about into over under more most some any can could would should will do does did done " +
		"how what why when where which who whom get got new now also very really too much many one " +
		"two using use used like make made"
	).split(" "),
);

/** Trailing-slash-insensitive key so `/blog/x` and `/blog/x/` match. */
function normalizeUrl(url) {
	if (typeof url !== "string") return "";
	const trimmed = url.trim();
	if (!trimmed) return "";
	return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function contentTags(item) {
	const raw = item?.data?.tags;
	if (!raw) return [];
	const list = Array.isArray(raw) ? raw : [raw];
	return list.filter((tag) => tag && !excludedTagSet.has(tag));
}

function tokenize(text) {
	if (!text) return [];
	return String(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/** Markdown links pointing at our own entries, absolute or root-relative. */
const ESCAPED_HOST = SITE_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ABSOLUTE_PREFIX = ESCAPED_HOST ? `(?:https?:\\/\\/(?:www\\.)?${ESCAPED_HOST})?` : "";
const INTERNAL_LINK_RE = new RegExp(`\\]\\(\\s*${ABSOLUTE_PREFIX}(\\/(?:blog|raw)\\/[a-z0-9-]+\\/?)\\s*[)"']`, "g");

function extractInternalLinks(rawInput) {
	const found = new Set();
	if (!rawInput) return found;
	for (const match of String(rawInput).matchAll(INTERNAL_LINK_RE)) {
		found.add(normalizeUrl(match[1]));
	}
	return found;
}

/**
 * @param {Array} pool Eleventy collection items (blog posts + raw notes)
 * @returns {Object} map of normalized URL → array of related collection items
 */
export function buildRelatedMap(pool) {
	const docs = [];
	for (const item of pool) {
		const url = normalizeUrl(item?.url);
		if (!url) continue;
		docs.push({
			item,
			url,
			isNote: String(item.inputPath || "").includes("content/raw/"),
			tags: contentTags(item),
			date: item.date ? new Date(item.date).getTime() : 0,
			links: extractInternalLinks(item.rawInput),
		});
	}

	const total = docs.length;
	const byUrl = new Map(docs.map((doc) => [doc.url, doc]));
	if (total === 0) return {};

	// --- tag IDF -----------------------------------------------------------
	const tagFreq = new Map();
	for (const doc of docs) {
		for (const tag of doc.tags) tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
	}
	// Clamped at 0: a tag on (nearly) every entry carries no information, and an
	// unclamped log() would go negative there — turning a shared tag into a penalty.
	const tagIdf = new Map();
	for (const [tag, freq] of tagFreq) tagIdf.set(tag, Math.max(0, Math.log(total / (1 + freq))));

	// --- TF-IDF vectors over title + description + body opening ------------
	const docFreq = new Map();
	for (const doc of docs) {
		const counts = new Map();
		const add = (text, weight) => {
			for (const word of tokenize(text)) counts.set(word, (counts.get(word) || 0) + weight);
		};
		add(doc.item.data?.title, FIELD_WEIGHTS.title);
		add(doc.item.data?.description, FIELD_WEIGHTS.description);
		add(String(doc.item.rawInput || "").slice(0, BODY_CHARS), FIELD_WEIGHTS.body);
		doc.counts = counts;
		for (const word of counts.keys()) docFreq.set(word, (docFreq.get(word) || 0) + 1);
	}
	for (const doc of docs) {
		const vector = new Map();
		let norm = 0;
		for (const [word, tf] of doc.counts) {
			// Clamped for the same reason as tag IDF: without it two entries sharing
			// only a ubiquitous word score cosine 1.0 — maximum similarity from the
			// least informative term.
			const idf = Math.max(0, Math.log(total / (1 + docFreq.get(word))));
			const value = (1 + Math.log(tf)) * idf;
			vector.set(word, value);
			norm += value * value;
		}
		doc.vector = vector;
		doc.norm = Math.sqrt(norm) || 1;
		delete doc.counts;
	}

	// --- symmetric internal-link graph -------------------------------------
	const linkedPairs = new Set();
	for (const doc of docs) {
		for (const target of doc.links) {
			if (!byUrl.has(target)) continue;
			linkedPairs.add(`${doc.url}|${target}`);
			linkedPairs.add(`${target}|${doc.url}`);
		}
	}

	const now = Date.now();

	function cosine(a, b) {
		// Iterate the smaller vector; lookups hit the larger one.
		const [small, large] = a.vector.size < b.vector.size ? [a, b] : [b, a];
		let dot = 0;
		for (const [word, value] of small.vector) {
			const other = large.vector.get(word);
			if (other) dot += value * other;
		}
		return dot / (a.norm * b.norm);
	}

	function score(current, candidate) {
		let tagScore = 0;
		if (current.tagSet.size && candidate.tags.length) {
			for (const tag of candidate.tags) {
				if (current.tagSet.has(tag)) tagScore += tagIdf.get(tag) || 0;
			}
			// Normalise so a heavily tagged entry can't win on volume alone.
			tagScore /= Math.sqrt(current.tags.length * candidate.tags.length) || 1;
		}

		const ageYears = Math.max(0, (now - candidate.date) / YEAR_MS);
		const recency = 1 / (1 + ageYears / RECENCY_HALFLIFE_YEARS);
		const linked = linkedPairs.has(`${current.url}|${candidate.url}`) ? 1 : 0;
		const sameType = candidate.isNote === current.isNote ? 1 : 0;

		return (
			WEIGHTS.tags * tagScore +
			WEIGHTS.text * cosine(current, candidate) +
			WEIGHTS.link * linked +
			WEIGHTS.recency * recency +
			WEIGHTS.sameType * sameType
		);
	}

	for (const doc of docs) doc.tagSet = new Set(doc.tags);

	const map = {};
	for (const current of docs) {
		// `related:` frontmatter pins entries to the top, in the order given.
		const pinned = [];
		const pinnedUrls = new Set();
		const overrides = current.item.data?.related;
		if (overrides) {
			for (const entry of Array.isArray(overrides) ? overrides : [overrides]) {
				if (pinned.length >= LIMIT) break;
				const target = normalizeUrl(entry);
				if (!target || target === current.url || pinnedUrls.has(target)) continue;
				const doc = byUrl.get(target);
				if (!doc) {
					console.warn(`[related] ${current.url}: unknown related URL "${entry}"`);
					continue;
				}
				pinned.push(doc.item);
				pinnedUrls.add(target);
			}
		}

		const scored = [];
		if (pinned.length < LIMIT) {
			for (const candidate of docs) {
				if (candidate.url === current.url || pinnedUrls.has(candidate.url)) continue;
				const value = score(current, candidate);
				if (value < SCORE_FLOOR) continue;
				scored.push({ item: candidate.item, value, date: candidate.date });
			}
			// Date breaks exact ties so the build stays stable run to run.
			scored.sort((a, b) => b.value - a.value || b.date - a.date);
		}

		map[current.url] = [...pinned, ...scored.slice(0, Math.max(0, LIMIT - pinned.length)).map((entry) => entry.item)];
	}

	return map;
}
