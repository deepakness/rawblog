export default {
	// Social image: frontmatter `image` wins, then the co-located og.jpeg that
	// `pnpm ready` generates for posts and notes. Other pages fall back to
	// `metadata.image` in base.njk.
	ogImage: (data) => {
		if (data.image) return data.image;
		const url = data.page?.url;
		if (url && (url.startsWith("/blog/") || url.startsWith("/raw/"))) return `${url}og.jpeg`;
		return null;
	},
};
