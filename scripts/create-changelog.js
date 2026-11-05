import fs from "fs";
import path from "path";
import { formatSiteDate, openInEditor, rootDir } from "./lib/create-utils.js";

const CHANGELOG_FILE = path.join(rootDir, "_data", "changelog.json");

function parseArgs(argv) {
	const args = argv.slice(2);
	const flags = {};
	const positionals = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			if (key === "link") {
				const value = args[i + 1];
				if (!value || value.startsWith("--")) {
					console.error("Each --link needs a value like label=/path/");
					process.exit(1);
				}
				flags.link = flags.link || [];
				flags.link.push(args[++i]);
				continue;
			}
			const next = args[i + 1];
			flags[key] = next && !next.startsWith("--") ? args[++i] : true;
		} else if (arg.startsWith("-") && arg !== "-") {
			const key = arg.slice(1);
			const longKey = key === "d" ? "description" : key;
			const next = args[i + 1];
			flags[longKey] = next && !next.startsWith("-") ? args[++i] : true;
		} else {
			positionals.push(arg);
		}
	}

	return { positionals, flags };
}

function parseLink(value) {
	const eq = value.indexOf("=");
	if (eq === -1) {
		console.error(`Invalid --link value: "${value}"`);
		console.error("Use: --link label=/path/  (e.g. --link page=/about/)");
		process.exit(1);
	}

	const label = value.slice(0, eq).trim();
	const url = value.slice(eq + 1).trim();

	if (!label || !url) {
		console.error(`Invalid --link value: "${value}"`);
		console.error("Use: --link label=/path/");
		process.exit(1);
	}

	return { label, url };
}

function loadChangelog() {
	if (!fs.existsSync(CHANGELOG_FILE)) {
		return [];
	}
	try {
		const data = JSON.parse(fs.readFileSync(CHANGELOG_FILE, "utf-8"));
		return Array.isArray(data) ? data : [];
	} catch (error) {
		console.error(`Error reading ${CHANGELOG_FILE}: ${error.message}`);
		process.exit(1);
	}
}

function saveChangelog(entries) {
	fs.writeFileSync(CHANGELOG_FILE, `${JSON.stringify(entries, null, "\t")}\n`);
}

function main() {
	const { positionals, flags } = parseArgs(process.argv);
	const title = positionals[0];
	const descriptionFromArg = positionals[1];

	if (!title) {
		console.error("Please provide a title for the changelog entry");
		console.error('Example: pnpm changelog "New about page"');
		console.error('Example: pnpm changelog "New about page" "Warm cream reading theme with monochrome links."');
		console.error("Flags: --description / -d, --date, --link label=/path/");
		process.exit(1);
	}

	const date = flags.date || formatSiteDate();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		console.error(`Invalid --date: "${date}" (use YYYY-MM-DD)`);
		process.exit(1);
	}

	const description =
		(typeof flags.description === "string" ? flags.description : null) || descriptionFromArg || "ADD DESCRIPTION HERE";

	const entry = {
		date,
		title,
		description,
	};

	if (flags.link?.length) {
		entry.links = flags.link.map(parseLink);
	}

	const changelog = loadChangelog();
	saveChangelog([entry, ...changelog]);

	console.log("\n✓ Changelog entry added");
	console.log(`  Date:  ${entry.date}`);
	console.log(`  Title: ${entry.title}`);
	console.log(`  Desc:  ${entry.description}`);
	if (entry.links) {
		for (const link of entry.links) {
			console.log(`  Link:  ${link.label} → ${link.url}`);
		}
	}
	console.log(`  File:  ${CHANGELOG_FILE}`);

	console.log("\nOpening the file...");
	openInEditor(CHANGELOG_FILE);
}

main();
