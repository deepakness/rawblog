import dotenv from "dotenv";
import site from "../site.config.js";

// Loaded here so ASSET_ORIGIN from .env is available to the build and to every script.
dotenv.config({ quiet: true });

const stripSlash = (value) =>
	String(value || "")
		.trim()
		.replace(/\/+$/, "");

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function validZone(zone) {
	if (!zone) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		console.warn(`[site.config.js] Unknown timezone "${zone}", using UTC`);
		return "UTC";
	}
}

/** Site URL without a trailing slash, e.g. "https://example.com". */
export const SITE_URL = stripSlash(site.url);

/** Hostname without "www.", e.g. "example.com". Empty when the URL is invalid. */
export const SITE_HOST = hostOf(SITE_URL);

/** IANA timezone every date on the site is shown in. */
export const SITE_ZONE = validZone(site.timezone);

/** Public origin for /blog/ and /raw/ media (e.g. an R2 bucket). Empty serves media from the site. */
export const ASSET_ORIGIN = stripSlash(process.env.ASSET_ORIGIN);

export default site;
