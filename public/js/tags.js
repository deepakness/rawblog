/**
 * Tags page – client-side multi-sort (recency, popularity, A-Z) and URL state sync.
 */
(function () {
	function initTags() {
		const listEl = document.getElementById("tags-list");
		const sortButtons = Array.from(document.querySelectorAll(".tags-sort-btn"));

		if (!listEl || sortButtons.length === 0) return;

		let items = Array.from(listEl.querySelectorAll(".tags-page-item"));
		let currentSort = "popularity";

		function setSortActive(sortType) {
			currentSort = sortType;
			for (const btn of sortButtons) {
				const isActive = btn.dataset.sort === sortType;
				btn.classList.toggle("is-active", isActive);
				btn.setAttribute("aria-selected", isActive ? "true" : "false");
			}
		}

		function updateUrl(sort, { push = false } = {}) {
			const url = new URL(window.location);
			if (sort && sort !== "popularity") {
				url.searchParams.set("sort", sort);
			} else {
				url.searchParams.delete("sort");
			}

			const state = { sort };
			if (push) {
				window.history.pushState(state, "", url);
			} else {
				window.history.replaceState(state, "", url);
			}
		}

		function sortDomItems(sortType) {
			items.sort((a, b) => {
				if (sortType === "recency") {
					const latestA = parseInt(a.dataset.latest || "0", 10);
					const latestB = parseInt(b.dataset.latest || "0", 10);
					if (latestB !== latestA) return latestB - latestA;
					const countA = parseInt(a.dataset.count || "0", 10);
					const countB = parseInt(b.dataset.count || "0", 10);
					if (countB !== countA) return countB - countA;
					return (a.dataset.name || "").localeCompare(b.dataset.name || "");
				} else if (sortType === "popularity") {
					const countA = parseInt(a.dataset.count || "0", 10);
					const countB = parseInt(b.dataset.count || "0", 10);
					if (countB !== countA) return countB - countA;
					const latestA = parseInt(a.dataset.latest || "0", 10);
					const latestB = parseInt(b.dataset.latest || "0", 10);
					if (latestB !== latestA) return latestB - latestA;
					return (a.dataset.name || "").localeCompare(b.dataset.name || "");
				} else if (sortType === "alphabetical") {
					return (a.dataset.name || "").localeCompare(b.dataset.name || "");
				}
				return 0;
			});

			const fragment = document.createDocumentFragment();
			for (const item of items) {
				fragment.appendChild(item);
			}
			listEl.appendChild(fragment);
		}

		function applySort({ push = false } = {}) {
			sortDomItems(currentSort);
			updateUrl(currentSort, { push });
		}

		function readUrlState() {
			const params = new URLSearchParams(window.location.search);
			const sort = params.get("sort") || "popularity";
			if (["recency", "popularity", "alphabetical"].includes(sort)) {
				setSortActive(sort);
			} else {
				setSortActive("popularity");
			}
		}

		readUrlState();
		applySort();

		for (const btn of sortButtons) {
			btn.addEventListener("click", () => {
				const sortType = btn.dataset.sort;
				if (sortType && sortType !== currentSort) {
					setSortActive(sortType);
					applySort({ push: true });
				}
			});
		}

		window.addEventListener("popstate", () => {
			readUrlState();
			applySort();
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initTags);
	} else {
		initTags();
	}
})();
