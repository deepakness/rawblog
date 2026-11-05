/**
 * The single draft policy, shared by the "drafts" preprocessor and the
 * collections in eleventy.config.js and by _data/siteStats.js,
 * so what the site builds and what the totals count can never disagree.
 *
 * Frontmatter parsed off disk (siteStats) yields strings where Eleventy gives
 * booleans, so the explicit string falses count as published too.
 */
export function isDraftData(data = {}) {
	if (data.status === "draft") return true;
	const { draft } = data;
	return draft !== undefined && draft !== false && draft !== "false" && draft !== "";
}
