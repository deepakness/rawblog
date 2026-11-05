import { fetchGithubActivity } from "../scripts/lib/github-contributions.js";
import site from "../_config/site.js";

// Empty when no GitHub username is configured, so templates hide the section.
export default async function () {
	if (!site.githubUsername) return null;
	return await fetchGithubActivity();
}
