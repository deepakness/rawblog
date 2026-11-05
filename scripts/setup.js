/**
 * Interactive first-run setup: `pnpm site:setup`
 *
 * Asks for the basics and writes them into site.config.js (comments and
 * everything else in the file are kept). Copies .env.example to .env if
 * there is no .env yet. Safe to run again; current values are the defaults.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { stdin as input, stdout as output } from "process";
import { fileURLToPath } from "url";
import site from "../site.config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "site.config.js");

const rl = readline.createInterface({ input, output, terminal: input.isTTY });
// Read lines through the async iterator rather than rl.question(), so piped
// answers (e.g. `printf '...' | pnpm site:setup`) are not dropped.
const lines = rl[Symbol.asyncIterator]();

async function ask(question, fallback = "") {
	const hint = fallback ? ` (${fallback})` : "";
	output.write(`${question}${hint}: `);
	const { value, done } = await lines.next();
	if (!input.isTTY) output.write("\n");
	const answer = done ? "" : String(value).trim();
	return answer || fallback;
}

function isValidZone(zone) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

const js = (value) => JSON.stringify(value);

/** Replace the value of `key: "…"` inside the block that starts at `anchor` (or the whole file). */
function setString(source, key, value, anchor) {
	const start = anchor ? source.indexOf(anchor) : 0;
	if (start < 0) throw new Error(`site.config.js: could not find ${anchor}`);
	const re = new RegExp(`(\\n\\t+${key}: )"[^"\\n]*"`);
	const head = source.slice(0, start);
	const tail = source.slice(start);
	if (!re.test(tail)) throw new Error(`site.config.js: could not find ${key}`);
	return head + tail.replace(re, (_, prefix) => prefix + js(value));
}

const PROMPTED_SOCIALS = [
	{ key: "github", label: "GitHub", icon: "github-logo" },
	{ key: "x", label: "X (Twitter)", icon: "x-logo" },
	{ key: "mastodon", label: "Mastodon", icon: "mastodon-logo" },
	{ key: "linkedin", label: "LinkedIn", icon: "linkedin-logo" },
	{ key: "bluesky", label: "Bluesky", icon: "butterfly" },
];

const socialKey = (social) => PROMPTED_SOCIALS.find((p) => social.label === p.label)?.key;
const currentSocial = (key) => {
	const url = (site.socials || []).find((s) => socialKey(s) === key)?.url || "";
	return /your-username|your-handle/.test(url) ? "" : url;
};

/**
 * Updates the prompted platforms in place, keeps any other socials (and the
 * commented-out examples) as they were, and appends newly added platforms.
 */
function socialsBlock(source, answers) {
	const block = source.match(/\tsocials: \[[\s\S]*?\n?\t?\],/)?.[0] || "";
	const comments = block.split("\n").filter((line) => line.trim().startsWith("//"));
	const socials = [];
	for (const social of site.socials || []) {
		const key = socialKey(social);
		if (!key) socials.push(social);
		else if (answers[key]) socials.push({ ...social, url: answers[key] });
	}
	for (const p of PROMPTED_SOCIALS) {
		if (answers[p.key] && !socials.some((s) => socialKey(s) === p.key)) {
			socials.push({ label: p.label, url: answers[p.key], icon: p.icon });
		}
	}
	const lines = [
		...socials.map((s) => `\t\t{ label: ${js(s.label)}, url: ${js(s.url)}, icon: ${js(s.icon)} },`),
		...comments,
	];
	return lines.length ? `\tsocials: [\n${lines.join("\n")}\n\t],` : "\tsocials: [],";
}

function isValidUrl(value) {
	try {
		return Boolean(new URL(value).hostname);
	} catch {
		return false;
	}
}

function normalizeUrl(value) {
	const url = value.trim().replace(/\/+$/, "");
	return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

async function main() {
	console.log("\nrawblog setup. Press Enter to keep the value in brackets.\n");

	const name = await ask("Your name", site.author.name);
	const title = await ask("Site title", site.title === "Your Name" ? name : site.title);
	let url = normalizeUrl(await ask("Site URL", site.url));
	while (!isValidUrl(url)) {
		url = normalizeUrl(await ask(`"${url}" is not a valid URL, try again`, site.url));
	}
	const description = await ask("One-line site description", site.description);
	const email = await ask("Contact email", site.author.email);

	const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	let timezone = await ask("Timezone (IANA name)", site.timezone === "UTC" ? detectedZone : site.timezone);
	while (!isValidZone(timezone)) {
		timezone = await ask(`"${timezone}" is not a valid IANA timezone, try again`, "UTC");
	}

	console.log("\nSocial profiles. Leave empty to skip.\n");
	const githubDefault = site.githubUsername || currentSocial("github").split("/").pop();
	const githubUsername = await ask("GitHub username (enables contribution stats)", githubDefault);
	const x = await ask("X (Twitter) profile URL", currentSocial("x"));
	const mastodon = await ask("Mastodon profile URL, e.g. https://mastodon.social/@you", currentSocial("mastodon"));
	const linkedin = await ask("LinkedIn profile URL", currentSocial("linkedin"));
	const bluesky = await ask("Bluesky profile URL", currentSocial("bluesky"));

	console.log("\nOptional analytics.\n");
	const umamiSrc = await ask("Umami script URL", site.analytics.umamiSrc);
	const umamiId = umamiSrc ? await ask("Umami website ID", site.analytics.umamiId) : "";

	rl.close();

	const answers = {
		github: githubUsername ? `https://github.com/${githubUsername}` : "",
		x,
		mastodon,
		linkedin,
		bluesky,
	};

	let mastodonInstance = "";
	let mastodonUser = "";
	const m = mastodon.match(/^(https?:\/\/[^/]+)\/@([^/?#]+)/);
	if (m) [, mastodonInstance, mastodonUser] = m;
	const twitterHandle = x.match(/(?:x|twitter)\.com\/([^/?#]+)/)?.[1] || site.twitterHandle;

	let source = fs.readFileSync(CONFIG_FILE, "utf-8");
	source = setString(source, "title", title);
	source = setString(source, "url", url);
	source = setString(source, "timezone", timezone);
	source = setString(source, "description", description);
	source = setString(source, "name", name, "author: {");
	source = setString(source, "email", email, "author: {");
	source = setString(source, "url", `${url}/about/`, "author: {");
	source = setString(source, "twitterHandle", twitterHandle);
	source = setString(source, "githubUsername", githubUsername);
	source = setString(source, "umamiSrc", umamiSrc, "analytics: {");
	source = setString(source, "umamiId", umamiId, "analytics: {");
	source = setString(source, "instance", mastodonInstance, "mastodon: {");
	source = setString(source, "username", mastodonUser, "mastodon: {");
	source = setString(source, "footerText", new URL(url).host, "ogImage: {");
	source = source.replace(/\tsocials: \[[\s\S]*?\n?\t?\],/, socialsBlock(source, answers));
	fs.writeFileSync(CONFIG_FILE, source);
	console.log("\n✔ Updated site.config.js");

	const envFile = path.join(ROOT, ".env");
	if (!fs.existsSync(envFile)) {
		fs.copyFileSync(path.join(ROOT, ".env.example"), envFile);
		console.log("✔ Created .env from .env.example (all integrations off)");
	}

	console.log(`
Next steps
  1. Replace public/img/avatar.png and avatar.webp with your photo.
  2. Edit content/index.njk, about.njk and now.njk, and the data in _data/.
  3. Delete the sample posts in content/blog/ and content/raw/.
  4. pnpm ready && pnpm start
  5. pnpm check --strict before you deploy.
`);
}

main().catch((error) => {
	rl.close();
	console.error(error.message);
	process.exit(1);
});
