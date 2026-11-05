/**
 * Shared search index loader with per-scope fetch and prefetch support.
 * Loaded on search pages and on-demand via "/" keyboard shortcut elsewhere.
 */
(() => {
	const URLS = {
		blog: "/search-index-blog.json",
		raw: "/search-index-raw.json",
	};

	const VALID_SCOPES = ["all", "blog", "raw"];
	const COLLECTION_SCOPES = ["blog", "raw"];

	/** @type {Record<string, object[] | null>} */
	const cachedPosts = { blog: null, raw: null };
	/** @type {Record<string, Promise<object[]> | null>} */
	const loadPromises = { blog: null, raw: null };

	function normalizeScope(scope) {
		return VALID_SCOPES.includes(scope) ? scope : "all";
	}

	function scopesForRequest(scope) {
		const normalized = normalizeScope(scope);
		if (normalized === "all") {
			return COLLECTION_SCOPES;
		}
		return [normalized];
	}

	function loadScopePosts(scope) {
		if (cachedPosts[scope]) {
			return Promise.resolve(cachedPosts[scope]);
		}

		if (!loadPromises[scope]) {
			loadPromises[scope] = fetch(URLS[scope])
				.then((response) => {
					if (!response.ok) {
						throw new Error(`Failed to load ${scope} search index`);
					}
					return response.json();
				})
				.then((data) => {
					const posts = Array.isArray(data) ? data : [];
					cachedPosts[scope] = posts;
					return posts;
				})
				.catch((error) => {
					loadPromises[scope] = null;
					throw error;
				});
		}

		return loadPromises[scope];
	}

	function getScopePosts(scope) {
		if (!COLLECTION_SCOPES.includes(scope)) {
			return Promise.reject(new Error(`Invalid scope: ${scope}`));
		}
		return loadScopePosts(scope);
	}

	function getIndex(scope = "all") {
		const scopes = scopesForRequest(scope);
		return Promise.all(scopes.map((collectionScope) => loadScopePosts(collectionScope))).then((results) => {
			const index = { blog: [], raw: [] };
			scopes.forEach((collectionScope, indexPosition) => {
				index[collectionScope] = results[indexPosition];
			});
			return index;
		});
	}

	function prefetch(scope = "all") {
		return getIndex(scope).catch(() => undefined);
	}

	function isScopeReady(scope) {
		const normalized = normalizeScope(scope);
		if (normalized === "all") {
			return cachedPosts.blog !== null && cachedPosts.raw !== null;
		}
		return cachedPosts[normalized] !== null;
	}

	window.SiteSearchIndex = {
		URLS,
		getScopePosts,
		getIndex,
		prefetch,
		isScopeReady(scope = "all") {
			return isScopeReady(scope);
		},
		isReady() {
			return isScopeReady("all");
		},
	};
})();
