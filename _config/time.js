import { DateTime } from "luxon";
import { SITE_ZONE } from "./site.js";

export { SITE_ZONE };

/**
 * Parse a Date, ISO string, or `yyyy-MM-dd HH:mm:ss[.SSS]ZZ` string
 * into a luxon DateTime in the site timezone. Returns null when invalid.
 */
export function toSiteDateTime(input) {
	if (input == null || input === "") return null;
	let dt;
	if (input instanceof Date) {
		// YAML turns a bare `2026-11-06` into midnight UTC. Keep it as that
		// calendar day instead of shifting it into the site timezone.
		const isCalendarDay =
			input.getUTCHours() === 0 &&
			input.getUTCMinutes() === 0 &&
			input.getUTCSeconds() === 0 &&
			input.getUTCMilliseconds() === 0;
		dt = isCalendarDay
			? DateTime.fromJSDate(input, { zone: "utc" }).setZone(SITE_ZONE, { keepLocalTime: true })
			: DateTime.fromJSDate(input, { zone: SITE_ZONE });
	} else if (typeof input === "string") {
		dt = DateTime.fromISO(input.trim().replace(" ", "T"), { zone: SITE_ZONE });
		if (!dt.isValid) dt = DateTime.fromFormat(input, "yyyy-MM-dd HH:mm:ss.SSSZZ", { zone: SITE_ZONE });
		if (!dt.isValid) dt = DateTime.fromFormat(input, "yyyy-MM-dd HH:mm:ssZZ", { zone: SITE_ZONE });
		if (dt.isValid) dt = dt.setZone(SITE_ZONE);
	} else if (typeof input === "number") {
		dt = DateTime.fromMillis(input, { zone: SITE_ZONE });
	}
	return dt && dt.isValid ? dt : null;
}

/** Current time in the site timezone. */
export function siteNow() {
	return DateTime.now().setZone(SITE_ZONE);
}
