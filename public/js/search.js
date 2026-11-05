/**
 * Search UI – lazy index loading with substring fallback and lazy Fuse.js search.
 */
(function () {
	const RESULTS_PAGE_SIZE = 15;
	const DEBOUNCE_MS = 250;
	const MIN_QUERY_LENGTH = 2;
	const FUSE_MODULE_URL = "/js/fuse.min.mjs";
	const VALID_SCOPES = ["all", "blog", "raw"];
	const COLLECTION_SCOPES = ["blog", "raw"];

	let initialized = false;

	function boot() {
		if (initialized) return;
		if (!document.getElementById("search-form")) return;

		initialized = true;
		initializeSearch();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}

	function initializeSearch() {
		const container = document.querySelector("[data-search-widget], .search-container");
		const searchForm = document.getElementById("search-form");
		const searchInput = document.getElementById("search-input");
		const searchScopeRadios = document.querySelectorAll('input[name="search-scope"]');
		const searchResultsContainer = document.getElementById("search-results");
		const searchStats = document.getElementById("search-stats");

		const syncUrl = container?.dataset.syncUrl === "true";
		const shouldAutofocus = container?.dataset.autofocus === "true";

		const scopeData = { blog: [], raw: [] };
		const scopeReady = { blog: false, raw: false };
		const scopeLoadPromises = { blog: null, raw: null };
		const fuseInstances = { all: null, blog: null, raw: null };
		const fusePendingScopes = new Set();

		let currentScope = "all";
		let debounceTimer = null;
		let fuseLoadPromise = null;
		let currentResults = [];
		let displayedCount = 0;
		let pendingSearch = null;

		const fuseOptions = {
			keys: [
				{ name: "title", weight: 0.4 },
				{ name: "description", weight: 0.2 },
				{ name: "tags", weight: 0.25 },
				{ name: "content", weight: 0.15 },
			],
			threshold: 0.3,
			ignoreLocation: true,
			includeScore: true,
			includeMatches: true,
			minMatchCharLength: 2,
		};

		if (shouldAutofocus) {
			setTimeout(() => searchInput.focus(), 100);
		}

		function getSelectedScope() {
			const checked = Array.from(searchScopeRadios).find((radio) => radio.checked);
			return checked ? checked.value : "all";
		}

		function normalizeScope(scope) {
			return VALID_SCOPES.includes(scope) ? scope : "all";
		}

		function scopesNeededFor(scope) {
			const normalized = normalizeScope(scope);
			return normalized === "all" ? COLLECTION_SCOPES : [normalized];
		}

		function isScopeDataReady(scope) {
			return scopesNeededFor(scope).every((collectionScope) => scopeReady[collectionScope]);
		}

		function showInitialState() {
			searchResultsContainer.innerHTML = `
        <div class="search-initial-state">
          <p>Enter keywords above to search the site.</p>
          <p class="search-tips">Results update as you type. Press <kbd class="search-kbd">/</kbd> anywhere on the site to jump here.</p>
        </div>
      `;
			searchStats.textContent = "";
			currentResults = [];
			displayedCount = 0;
		}

		function showTooShort() {
			searchResultsContainer.innerHTML = '<div class="no-results">Please enter at least 2 characters to search.</div>';
			searchStats.textContent = "";
			currentResults = [];
			displayedCount = 0;
		}

		function showLoading() {
			searchResultsContainer.innerHTML =
				'<div class="no-results">Search index is still loading. Please try again in a moment.</div>';
			searchStats.textContent = "";
			currentResults = [];
			displayedCount = 0;
		}

		function showIndexError() {
			searchResultsContainer.innerHTML =
				'<div class="search-error"><strong>Error:</strong> Failed to load search data. Please try again later.</div>';
			searchStats.textContent = "";
			currentResults = [];
			displayedCount = 0;
		}

		function updateUrl(query, scope, { push = false } = {}) {
			if (!syncUrl) return;

			const url = new URL(window.location);
			if (query) {
				url.searchParams.set("q", query);
				url.searchParams.set("scope", scope);
			} else {
				url.searchParams.delete("q");
				url.searchParams.delete("scope");
			}

			const state = { query, scope };
			if (push) {
				window.history.pushState(state, "", url);
			} else {
				window.history.replaceState(state, "", url);
			}
		}

		function tagPosts(posts, collection) {
			return posts.map((post) => ({ ...post, collection }));
		}

		function getPostsForScope(scope) {
			const normalized = normalizeScope(scope);
			if (normalized === "blog") {
				return tagPosts(scopeData.blog, "blog");
			}
			if (normalized === "raw") {
				return tagPosts(scopeData.raw, "raw");
			}
			return [...tagPosts(scopeData.blog, "blog"), ...tagPosts(scopeData.raw, "raw")];
		}

		function postSearchText(post) {
			return [post.title, post.description, ...(post.tags || []), post.content].filter(Boolean).join(" ");
		}

		function matchesSubstring(post, query) {
			return postSearchText(post).toLowerCase().includes(query.toLowerCase());
		}

		function substringSearch(query, scope) {
			const posts = getPostsForScope(scope);
			return posts
				.filter((post) => matchesSubstring(post, query))
				.map((post) => ({ item: post, score: 0, matches: null }));
		}

		function loadScopePosts(collectionScope) {
			if (scopeReady[collectionScope]) {
				return Promise.resolve(scopeData[collectionScope]);
			}

			if (scopeLoadPromises[collectionScope]) {
				return scopeLoadPromises[collectionScope];
			}

			const loader = window.SiteSearchIndex
				? window.SiteSearchIndex.getScopePosts(collectionScope)
				: fetch(`/search-index-${collectionScope}.json`).then((response) => {
						if (!response.ok) throw new Error(`Failed to load ${collectionScope} search index`);
						return response.json();
					});

			scopeLoadPromises[collectionScope] = loader
				.then((posts) => {
					scopeData[collectionScope] = Array.isArray(posts) ? posts : [];
					scopeReady[collectionScope] = true;
					return scopeData[collectionScope];
				})
				.catch((error) => {
					scopeLoadPromises[collectionScope] = null;
					throw error;
				});

			return scopeLoadPromises[collectionScope];
		}

		function ensureScopeData(scope) {
			const scopes = scopesNeededFor(scope);
			return Promise.all(scopes.map((collectionScope) => loadScopePosts(collectionScope)));
		}

		function loadFuseScript() {
			if (typeof Fuse !== "undefined") return Promise.resolve();
			if (fuseLoadPromise) return fuseLoadPromise;

			fuseLoadPromise = import(FUSE_MODULE_URL)
				.then((mod) => {
					window.Fuse = mod.default;
				})
				.catch((error) => {
					fuseLoadPromise = null;
					throw error instanceof Error ? error : new Error("Failed to load Fuse.js");
				});

			return fuseLoadPromise;
		}

		function buildFuseInstance(scope) {
			const normalized = normalizeScope(scope);
			if (!isScopeDataReady(normalized) || typeof Fuse === "undefined") return;
			fuseInstances[normalized] = new Fuse(getPostsForScope(normalized), fuseOptions);
		}

		function ensureFuse(scope) {
			const normalized = normalizeScope(scope);
			fusePendingScopes.add(normalized);

			if (!isScopeDataReady(normalized)) {
				return Promise.resolve();
			}

			return loadFuseScript()
				.then(() => {
					if (!fuseInstances[normalized]) {
						buildFuseInstance(normalized);
					}
					const activeQuery = searchInput.value.trim();
					if (activeQuery.length >= MIN_QUERY_LENGTH && normalizeScope(getSelectedScope()) === normalized) {
						performSearch(activeQuery, normalized);
					}
				})
				.catch((error) => {
					console.error("Error loading Fuse.js:", error);
				});
		}

		function maybeEnsureFuse(scope, query) {
			if (query.length >= MIN_QUERY_LENGTH) {
				ensureFuse(scope);
			}
		}

		function resolvePendingFuseBuilds() {
			for (const scope of fusePendingScopes) {
				if (isScopeDataReady(scope) && !fuseInstances[scope]) {
					ensureFuse(scope);
				}
			}
		}

		function runSearch(query, scope, { push = false } = {}) {
			currentScope = normalizeScope(scope);
			updateUrl(query, currentScope, { push });

			if (!isScopeDataReady(currentScope)) {
				pendingSearch = { query, scope: currentScope };
				showLoading();
				return ensureScopeData(currentScope)
					.then(() => {
						resolvePendingFuseBuilds();
						maybeEnsureFuse(currentScope, query);
						if (pendingSearch && pendingSearch.scope === currentScope) {
							const pending = pendingSearch;
							pendingSearch = null;
							performSearch(pending.query, pending.scope);
						}
					})
					.catch((error) => {
						console.error("Error loading search index:", error);
						pendingSearch = null;
						showIndexError();
					});
			}

			maybeEnsureFuse(currentScope, query);
			performSearch(query, currentScope);
		}

		function scheduleSearch(query, scope, { push = false } = {}) {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				runSearch(query, scope, { push });
			}, DEBOUNCE_MS);
		}

		function performSearch(query, scope) {
			const normalizedScope = normalizeScope(scope);

			if (!isScopeDataReady(normalizedScope)) {
				showLoading();
				return;
			}

			let results;
			if (fuseInstances[normalizedScope]) {
				results = fuseInstances[normalizedScope].search(query);
			} else {
				results = substringSearch(query, normalizedScope);
			}

			if (results.length > 0) {
				currentResults = results.map((result) => ({
					...result.item,
					score: result.score,
					matches: result.matches,
				}));
				displayedCount = Math.min(RESULTS_PAGE_SIZE, currentResults.length);
				renderResults(query);
			} else {
				currentResults = [];
				displayedCount = 0;
				searchResultsContainer.innerHTML = `
          <div class="no-results">
            <p>No results found for "<strong>${escapeHTML(query)}</strong>".</p>
            <p>Try different keywords or broaden your search.</p>
          </div>
        `;
				searchStats.textContent = "0 results found";
			}
		}

		function applyUrlState() {
			const urlParams = new URLSearchParams(window.location.search);
			const query = urlParams.get("q");
			const scopeParam = urlParams.get("scope");
			const scope = VALID_SCOPES.includes(scopeParam) ? scopeParam : currentScope;
			const scopeInput = document.querySelector(`input[name="search-scope"][value="${scope}"]`);

			if (scopeInput) {
				scopeInput.checked = true;
			}
			currentScope = scopeInput ? scope : currentScope;

			if (query) {
				searchInput.value = query;
				if (query.trim().length >= MIN_QUERY_LENGTH) {
					runSearch(query.trim(), currentScope);
				} else {
					showTooShort();
				}
			} else {
				showInitialState();
			}
		}

		const urlParams = new URLSearchParams(window.location.search);
		if (urlParams.has("q") || urlParams.has("scope")) {
			applyUrlState();
		} else {
			showInitialState();
		}

		searchForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const query = searchInput.value.trim();

			if (query.length < MIN_QUERY_LENGTH) {
				showTooShort();
				return;
			}

			clearTimeout(debounceTimer);
			currentScope = getSelectedScope();
			runSearch(query, currentScope, { push: true });
		});

		searchScopeRadios.forEach((radio) => {
			radio.addEventListener("change", () => {
				const query = searchInput.value.trim();
				if (query.length < MIN_QUERY_LENGTH) return;

				currentScope = radio.value;
				runSearch(query, currentScope, { push: false });
			});
		});

		searchInput.addEventListener("focus", () => {
			const query = searchInput.value.trim();
			const scope = getSelectedScope();
			if (query.length >= MIN_QUERY_LENGTH) {
				ensureScopeData(scope).then(() => {
					resolvePendingFuseBuilds();
					maybeEnsureFuse(scope, query);
				});
			} else {
				ensureFuse(scope);
			}
		});

		searchInput.addEventListener("input", () => {
			const query = searchInput.value.trim();

			if (query.length === 0) {
				clearTimeout(debounceTimer);
				pendingSearch = null;
				updateUrl("", currentScope, { push: false });
				showInitialState();
				return;
			}

			if (query.length < MIN_QUERY_LENGTH) {
				clearTimeout(debounceTimer);
				pendingSearch = null;
				showTooShort();
				return;
			}

			currentScope = getSelectedScope();
			scheduleSearch(query, currentScope, { push: false });
		});

		window.addEventListener("popstate", () => {
			if (!syncUrl) return;
			applyUrlState();
		});

		function renderResults(query) {
			const terms = query
				.toLowerCase()
				.split(/\s+/)
				.filter((term) => term.length > 1);
			const blogCount = currentResults.filter((post) => post.collection === "blog").length;
			const noteCount = currentResults.filter((post) => post.collection === "raw").length;

			let statsText = `${currentResults.length} result${currentResults.length !== 1 ? "s" : ""} found`;
			if (displayedCount < currentResults.length) {
				statsText += ` · showing ${displayedCount}`;
			}
			if (blogCount > 0 && noteCount > 0) {
				statsText += ` · ${blogCount} blog · ${noteCount} note${noteCount !== 1 ? "s" : ""}`;
			}
			searchStats.textContent = statsText;

			const list = document.createElement("div");
			list.className = "postlist search-results-list";
			list.setAttribute("role", "list");

			currentResults.slice(0, displayedCount).forEach((post) => {
				list.appendChild(createResultElement(post, terms));
			});

			searchResultsContainer.innerHTML = "";
			searchResultsContainer.appendChild(list);

			if (displayedCount < currentResults.length) {
				const remaining = currentResults.length - displayedCount;
				const loadMoreBtn = document.createElement("button");
				loadMoreBtn.type = "button";
				loadMoreBtn.className = "search-load-more";
				loadMoreBtn.textContent = `Load more (${remaining} remaining)`;
				loadMoreBtn.addEventListener("click", () => {
					displayedCount = Math.min(displayedCount + RESULTS_PAGE_SIZE, currentResults.length);
					renderResults(query);
				});
				searchResultsContainer.appendChild(loadMoreBtn);
			}
		}

		function createResultElement(post, terms) {
			const article = document.createElement("article");
			article.className = "archive-entry search-entry";
			article.setAttribute("role", "listitem");

			const titleHeading = document.createElement("h3");
			titleHeading.className = "archive-entry-title search-entry-title";

			const titleLink = document.createElement("a");
			titleLink.href = post.url;
			titleLink.className = "postlist-link";
			titleLink.innerHTML = highlightTerms(escapeHTML(decodeHTMLEntities(post.title)), terms);
			titleHeading.appendChild(titleLink);

			const metadata = document.createElement("ul");
			metadata.className = "post-metadata archive-entry-metadata search-entry-metadata";

			const kindItem = document.createElement("li");
			kindItem.className = "archive-entry-kind search-entry-kind";
			const kindMark = document.createElement("span");
			if (post.collection === "raw") {
				kindMark.className = "entry-kind entry-kind-note";
				kindMark.title = "note";
				kindMark.setAttribute("aria-label", "note");
			} else {
				kindMark.className = "entry-kind entry-kind-blog";
				kindMark.title = "blog";
				kindMark.setAttribute("aria-label", "blog");
			}
			kindItem.appendChild(kindMark);

			if (post.date) {
				const time = document.createElement("time");
				time.dateTime = post.date.slice(0, 10);
				time.textContent = formatResultDate(post.date);
				kindItem.appendChild(time);
			}

			metadata.appendChild(kindItem);

			article.appendChild(titleHeading);
			article.appendChild(metadata);

			const snippetText = extractSnippet(post.content, terms, post.matches);
			if (snippetText) {
				const snippet = document.createElement("p");
				snippet.className = "search-snippet";
				snippet.innerHTML = highlightTerms(escapeHTML(decodeHTMLEntities(snippetText)), terms);
				article.appendChild(snippet);
			}

			return article;
		}

		function extractSnippet(content, terms, matches) {
			const maxSnippetLength = 200;
			const body = (content || "").trim();

			if (!body) return "";

			if (matches) {
				const contentMatch = matches.find((m) => m.key === "content");
				if (contentMatch && contentMatch.indices.length > 0) {
					const [start, end] = contentMatch.indices[0];
					let snippetStart = Math.max(0, start - 60);
					let snippetEnd = Math.min(body.length, end + 60);

					while (snippetStart > 0 && body[snippetStart] !== " " && body[snippetStart] !== ".") snippetStart--;
					while (snippetEnd < body.length && body[snippetEnd] !== " " && body[snippetEnd] !== ".") snippetEnd++;

					let snippet = body.substring(snippetStart, snippetEnd);
					if (snippetStart > 0) snippet = "…" + snippet;
					if (snippetEnd < body.length) snippet = snippet + "…";
					return snippet;
				}
			}

			for (const term of terms) {
				const index = body.toLowerCase().indexOf(term);
				if (index !== -1) {
					let start = Math.max(0, index - 60);
					let end = Math.min(body.length, index + term.length + 60);

					while (start > 0 && body[start] !== " " && body[start] !== ".") start--;
					while (end < body.length && body[end] !== " " && body[end] !== ".") end++;

					let snippet = body.substring(start, end);
					if (start > 0) snippet = "…" + snippet;
					if (end < body.length) snippet = snippet + "…";
					return snippet;
				}
			}

			return body.substring(0, maxSnippetLength) + (body.length > maxSnippetLength ? "…" : "");
		}

		function formatResultDate(dateString) {
			return new Date(dateString).toLocaleDateString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
		}

		function highlightTerms(text, terms) {
			let highlightedText = text;
			terms.forEach((term) => {
				const regex = new RegExp("(" + escapeRegExp(term) + ")", "gi");
				highlightedText = highlightedText.replace(regex, "<mark>$1</mark>");
			});
			return highlightedText;
		}

		function escapeRegExp(string) {
			return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}

		function escapeHTML(str) {
			return str
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#039;");
		}

		function decodeHTMLEntities(text) {
			const textarea = document.createElement("textarea");
			textarea.innerHTML = text;
			return textarea.value;
		}
	}
})();
