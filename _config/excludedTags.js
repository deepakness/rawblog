/**
 * System / cascade tags that must not appear as content tags
 * (tag index, tag pages, related posts, filterTagList).
 */
export const EXCLUDED_TAGS = [
	"all",
	"posts",
	"raw",
	"archiveByYear",
	"archiveFeed",
	"homeFeedBlended",
	"homefeedblended",
	"null",
	"contentTagList",
];

export const excludedTagSet = new Set(EXCLUDED_TAGS);
