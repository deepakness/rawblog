import { createSlugIndexEntry, requireSlug, titleCaseFromSlug } from "./lib/create-utils.js";

const slug = requireSlug(process.argv[2], {
	example: "pnpm blog my-new-post",
	label: "blog post",
});

createSlugIndexEntry({
	type: "blog",
	slug,
	title: titleCaseFromSlug(slug),
	description: "Add your description here",
	body: "Write your blog post content here...",
	successLabel: "Blog post",
});
