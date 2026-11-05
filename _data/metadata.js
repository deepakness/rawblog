import site, { SITE_URL, SITE_ZONE } from "../_config/site.js";

// Templates read the site config as `metadata`. A few derived fields are
// added here so site.config.js stays simple.
export default {
	...site,
	url: SITE_URL,
	timezone: SITE_ZONE,
	author: {
		...site.author,
		sameAs: (site.socials || []).map((social) => social.url).filter(Boolean),
	},
};
