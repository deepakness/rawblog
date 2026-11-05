import { fetchGithubContributions } from "../scripts/lib/github-contributions.js";
import site from "../_config/site.js";

export default async function () {
	if (!site.githubUsername) return 0;
	return await fetchGithubContributions({ isCurrentYear: false });
}
