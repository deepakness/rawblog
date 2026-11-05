/**
 * Bookmarks page – progressive enhancement over server-rendered list.
 * List HTML ships in the page; JS adds search/filter (Fuse.js lazy-loaded).
 */
(function () {
	const DEBOUNCE_MS = 250;
	const MIN_QUERY_LENGTH = 2;
	const FUSE_MODULE_URL = "/js/fuse.min.mjs";

	let initialized = false;

	function boot() {
		if (initialized) return;
		if (!document.getElementById("bookmark-list")) return;

		initialized = true;
		initializeBookmarks();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}

	function initializeBookmarks() {
		const inputEl = document.getElementById("bookmarks-input");
		const statsEl = document.getElementById("bookmarks-stats");
		const listEl = document.getElementById("bookmark-list");
		const formEl = document.getElementById("bookmarks-form");

		let bookmarks = [];
		let itemEls = [];
		let bookmarksReady = false;
		let fuse = null;
		let fuseReady = false;
		let fusePending = false;
		let fuseLoadPromise = null;
		let debounceTimer = null;

		const fuseOptions = {
			keys: [
				{ name: "title", weight: 0.4 },
				{ name: "author", weight: 0.25 },
				{ name: "note", weight: 0.2 },
				{ name: "url", weight: 0.15 },
			],
			threshold: 0.35,
			ignoreLocation: true,
			minMatchCharLength: 2,
		};

		function normalizeUrl(url) {
			try {
				const parsed = new URL(url);
				parsed.hash = "";
				let normalized = parsed.toString();
				if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
				return normalized;
			} catch {
				return url;
			}
		}

		function getQuery() {
			return (inputEl.value || "").trim();
		}

		function isValidQuery(query) {
			return query.length >= MIN_QUERY_LENGTH;
		}

		function updateUrl(query, { push = false } = {}) {
			const url = new URL(window.location);
			if (isValidQuery(query)) {
				url.searchParams.set("q", query);
			} else {
				url.searchParams.delete("q");
			}

			const state = { query };
			if (push) {
				window.history.pushState(state, "", url);
			} else {
				window.history.replaceState(state, "", url);
			}
		}

		function bookmarkSearchText(bookmark) {
			return [bookmark.title, bookmark.author, bookmark.note, bookmark.url].filter(Boolean).join(" ");
		}

		function matchesSubstring(bookmark, query) {
			return bookmarkSearchText(bookmark).toLowerCase().includes(query.toLowerCase());
		}

		function getMatchingUrls(query) {
			if (!isValidQuery(query)) return null;

			if (fuseReady && fuse) {
				return new Set(fuse.search(query).map((r) => normalizeUrl(r.item.url)));
			}

			const matches = new Set();
			for (const bookmark of bookmarks) {
				if (matchesSubstring(bookmark, query)) {
					matches.add(normalizeUrl(bookmark.url));
				}
			}
			return matches;
		}

		function applySearch({ push = false } = {}) {
			if (!bookmarksReady) return;

			const query = getQuery();
			const totalCount = bookmarks.length;
			const matchingUrls = getMatchingUrls(query);
			let visibleCount = 0;

			for (const el of itemEls) {
				const show = !matchingUrls || matchingUrls.has(normalizeUrl(el.dataset.url));
				el.classList.toggle("is-hidden", !show);
				if (show) visibleCount++;
			}

			let statsText = `Showing ${visibleCount} of ${totalCount}`;
			if (isValidQuery(query)) {
				statsText += ` · matching "${query}"`;
			}
			statsEl.textContent = statsText;

			updateUrl(query, { push });
		}

		function readUrlState() {
			const params = new URLSearchParams(window.location.search);
			const rawQuery = params.get("q") || "";
			inputEl.value = params.has("q") && rawQuery !== "undefined" ? rawQuery : "";
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

		function initFuseIndex() {
			if (!bookmarksReady || typeof Fuse === "undefined") return;
			fuse = new Fuse(bookmarks, fuseOptions);
			fuseReady = true;
			applySearch();
		}

		function ensureFuse() {
			fusePending = true;
			if (!bookmarksReady) return Promise.resolve();

			return loadFuseScript()
				.then(() => {
					initFuseIndex();
				})
				.catch((error) => {
					console.error("Error loading Fuse.js:", error);
				});
		}

		function maybeLoadFuse() {
			const query = getQuery();
			if (isValidQuery(query)) {
				ensureFuse();
			}
		}

		function bookmarkFromElement(el) {
			return {
				url: el.dataset.url || "",
				title: el.dataset.title || "",
				author: el.dataset.author || "",
				note: el.dataset.note || "",
				domain: el.dataset.domain || "",
				dateFormatted: el.dataset.dateFormatted || "",
			};
		}

		function hydrateFromDom() {
			itemEls = Array.from(listEl.querySelectorAll(".bookmark-item"));
			if (itemEls.length === 0) return false;

			bookmarks = itemEls.map(bookmarkFromElement);
			bookmarksReady = true;
			listEl.setAttribute("aria-busy", "false");
			return true;
		}

		function createBookmarkItem(bookmark) {
			const li = document.createElement("li");
			li.className = "bookmark-item";
			li.dataset.url = bookmark.url;
			li.dataset.title = bookmark.title || "";
			li.dataset.author = bookmark.author || "";
			li.dataset.note = bookmark.note || "";
			li.dataset.domain = bookmark.domain || "";
			li.dataset.dateFormatted = bookmark.dateFormatted || "";

			const link = document.createElement("a");
			link.href = bookmark.url;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.className = "bookmark-title";
			link.textContent = bookmark.title;
			li.appendChild(link);

			if (bookmark.author) {
				const author = document.createElement("span");
				author.className = "bookmark-author";
				author.textContent = ` – ${bookmark.author}`;
				li.appendChild(author);
			}

			if (bookmark.note) {
				const note = document.createElement("span");
				note.className = "bookmark-note";

				const icon = document.createElement("span");
				icon.className = "bookmark-note-icon";
				icon.setAttribute("aria-hidden", "true");

				const noteText = document.createElement("span");
				noteText.className = "bookmark-note-text";
				noteText.textContent = bookmark.note;

				note.appendChild(icon);
				note.appendChild(noteText);
				li.appendChild(note);
			}

			const meta = document.createElement("span");
			meta.className = "bookmark-meta";
			let metaText = bookmark.domain || "";
			if (bookmark.dateFormatted) {
				metaText += metaText ? ` · added ${bookmark.dateFormatted}` : `added ${bookmark.dateFormatted}`;
			}
			meta.textContent = metaText;
			li.appendChild(meta);

			return li;
		}

		function renderBookmarks(data) {
			listEl.replaceChildren();
			const fragment = document.createDocumentFragment();

			for (const bookmark of data) {
				fragment.appendChild(createBookmarkItem(bookmark));
			}

			listEl.appendChild(fragment);
			itemEls = Array.from(listEl.querySelectorAll(".bookmark-item"));
			listEl.setAttribute("aria-busy", "false");
		}

		function showLoadError() {
			listEl.setAttribute("aria-busy", "false");
			listEl.replaceChildren();

			const message = document.createElement("li");
			message.className = "bookmarks-error";
			message.textContent = "Could not load bookmarks. Please try refreshing the page.";
			listEl.appendChild(message);

			statsEl.textContent = "";
		}

		function finishReady() {
			if (new URLSearchParams(window.location.search).has("q")) {
				readUrlState();
			}
			applySearch();
			if (fusePending || isValidQuery(getQuery())) {
				ensureFuse();
			}
		}

		// Prefer server-rendered list; fall back to JSON if the list is empty.
		if (hydrateFromDom()) {
			finishReady();
		} else {
			statsEl.textContent = "Loading bookmarks…";
			listEl.setAttribute("aria-busy", "true");

			fetch("/bookmarks-index.json")
				.then((response) => {
					if (!response.ok) throw new Error("Failed to load bookmarks index");
					return response.json();
				})
				.then((data) => {
					bookmarks = data;
					bookmarksReady = true;
					renderBookmarks(data);
					finishReady();
				})
				.catch((error) => {
					console.error("Error loading bookmarks index:", error);
					showLoadError();
				});
		}

		inputEl.addEventListener("focus", () => {
			ensureFuse();
		});

		inputEl.addEventListener("input", () => {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				applySearch();
				maybeLoadFuse();
			}, DEBOUNCE_MS);
		});

		formEl.addEventListener("submit", (event) => {
			event.preventDefault();
			clearTimeout(debounceTimer);
			applySearch({ push: true });
			maybeLoadFuse();
		});

		window.addEventListener("popstate", () => {
			readUrlState();
			applySearch();
			maybeLoadFuse();
		});
	}
})();
