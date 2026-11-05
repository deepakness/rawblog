import { createSlugIndexEntry, requireSlug, sentenceCaseFromSlug } from "./lib/create-utils.js";

const slug = requireSlug(process.argv[2], {
	example: "pnpm raw my-new-post",
	label: "raw note",
});

createSlugIndexEntry({
	type: "raw",
	slug,
	title: sentenceCaseFromSlug(slug),
	description: "ADD DESCRIPTION HERE",
	body: "Your raw thoughts here...",
	successLabel: "Raw note",
});
