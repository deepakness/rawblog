/**
 * Global search shortcuts: "/" to open/focus search, prefetch index on navigate intent.
 */
(() => {
	const SEARCH_INDEX_SCRIPT_URL = "/js/search-index.js";
	const PREFETCH_CAP_MS = 400;

	let indexLoaderPromise = null;

	function isEditableTarget(target) {
		if (!target || !(target instanceof Element)) {
			return false;
		}

		const tagName = target.tagName;
		if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
			return true;
		}

		return target.isContentEditable;
	}

	function focusSearchInput() {
		const input = document.getElementById("search-input");
		if (input) {
			input.focus();
			if (typeof input.select === "function") {
				input.select();
			}
			return true;
		}
		return false;
	}

	function ensureSearchIndex() {
		if (window.SiteSearchIndex) {
			return Promise.resolve(window.SiteSearchIndex);
		}

		if (!indexLoaderPromise) {
			indexLoaderPromise = new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = SEARCH_INDEX_SCRIPT_URL;
				script.onload = () => {
					if (window.SiteSearchIndex) {
						resolve(window.SiteSearchIndex);
					} else {
						reject(new Error("SiteSearchIndex not available"));
					}
				};
				script.onerror = () => reject(new Error("Failed to load search index script"));
				document.head.appendChild(script);
			});
		}

		return indexLoaderPromise;
	}

	function warmSearchAndNavigate() {
		const go = () => window.location.assign("/search/");
		const cap = new Promise((resolve) => setTimeout(resolve, PREFETCH_CAP_MS));

		ensureSearchIndex()
			.then((idx) => Promise.race([idx.prefetch(), cap]))
			.then(go)
			.catch(go);
	}

	document.addEventListener("keydown", (event) => {
		if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}

		if (isEditableTarget(event.target)) {
			return;
		}

		event.preventDefault();

		if (focusSearchInput()) {
			return;
		}

		warmSearchAndNavigate();
	});
})();
