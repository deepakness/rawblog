(() => {
	const nav = document.querySelector(".archive-year-nav");
	if (!nav) {
		return;
	}

	const wrap = nav.querySelector(".archive-year-all");
	const button = nav.querySelector(".archive-year-all-btn");
	const panel = nav.querySelector(".archive-year-map");
	if (!wrap || !button || !panel) {
		return;
	}

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const supportsPopover = typeof panel.showPopover === "function";
	const gutter = 12;

	function isOpen() {
		if (supportsPopover) {
			return panel.matches(":popover-open");
		}
		return wrap.classList.contains("is-open");
	}

	function setExpanded(open) {
		button.setAttribute("aria-expanded", open ? "true" : "false");
		wrap.classList.toggle("is-open", open);
	}

	function positionPanel() {
		const btnRect = button.getBoundingClientRect();
		// Panel sizes to its content in CSS – measure the real box for placement.
		const panelWidth = panel.offsetWidth || 240;
		const panelHeight = panel.offsetHeight || 280;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Prefer aligning the panel’s right edge with the button (rail sits on the left).
		let left = btnRect.right - panelWidth;
		if (left < gutter) {
			left = gutter;
		}
		if (left + panelWidth + gutter > viewportWidth) {
			left = Math.max(gutter, viewportWidth - panelWidth - gutter);
		}

		const spaceBelow = viewportHeight - btnRect.bottom - gutter;
		const spaceAbove = btnRect.top - gutter;
		const openAbove = spaceBelow < Math.min(panelHeight, 240) && spaceAbove > spaceBelow;

		let top;
		if (openAbove) {
			top = Math.max(gutter, btnRect.top - panelHeight - 8);
		} else {
			top = Math.min(btnRect.bottom + 8, viewportHeight - gutter - 80);
		}

		panel.style.setProperty("--archive-map-top", `${Math.round(top)}px`);
		panel.style.setProperty("--archive-map-left", `${Math.round(left)}px`);
		panel.style.setProperty("--archive-map-right", "auto");
		panel.style.removeProperty("--archive-map-width");
		panel.dataset.placement = openAbove ? "above" : "below";
	}

	function focusCurrentOrFirst() {
		const current =
			panel.querySelector(".archive-year-map-row[aria-current='page']") || panel.querySelector(".archive-year-map-row");
		if (!current) {
			return;
		}
		if (typeof current.focus === "function") {
			current.focus({ preventScroll: true });
		}
		if (typeof current.scrollIntoView === "function") {
			current.scrollIntoView({
				block: "nearest",
				behavior: reduceMotion.matches ? "auto" : "smooth",
			});
		}
	}

	function openPanel() {
		if (supportsPopover) {
			if (!isOpen()) {
				panel.showPopover();
			}
		} else {
			panel.hidden = false;
			setExpanded(true);
		}
		positionPanel();
		// Second pass after layout so height-based flip is accurate.
		requestAnimationFrame(() => {
			positionPanel();
			focusCurrentOrFirst();
		});
	}

	function closePanel(options) {
		const restoreFocus = Boolean(options && options.restoreFocus);
		if (supportsPopover) {
			if (isOpen()) {
				panel.hidePopover();
			}
		} else {
			panel.hidden = true;
			setExpanded(false);
		}
		panel.removeAttribute("data-placement");
		if (restoreFocus) {
			button.focus();
		}
	}

	function togglePanel() {
		if (isOpen()) {
			closePanel();
		} else {
			openPanel();
		}
	}

	// Keep aria-expanded in sync with the native popover lifecycle.
	panel.addEventListener("toggle", (event) => {
		const open = event.newState === "open" || isOpen();
		setExpanded(open);
		if (open) {
			positionPanel();
			requestAnimationFrame(() => {
				positionPanel();
				focusCurrentOrFirst();
			});
		} else {
			panel.removeAttribute("data-placement");
		}
	});

	button.addEventListener("click", (event) => {
		// With popovertarget, the browser toggles the popover. We only
		// intercept when the Popover API is missing.
		if (!supportsPopover) {
			event.preventDefault();
			togglePanel();
		}
	});

	if (!supportsPopover) {
		panel.hidden = true;
		document.addEventListener("click", (event) => {
			if (!isOpen()) {
				return;
			}
			if (!event.target.closest(".archive-year-all")) {
				closePanel();
			}
		});
	}

	document.addEventListener("keydown", (event) => {
		if (!isOpen()) {
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			closePanel({ restoreFocus: true });
			return;
		}

		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
			return;
		}

		const rows = Array.from(panel.querySelectorAll(".archive-year-map-row"));
		if (!rows.length) {
			return;
		}

		const activeEl = document.activeElement;
		const index = rows.indexOf(activeEl);
		let nextIndex = index;

		if (event.key === "Home") {
			nextIndex = 0;
		} else if (event.key === "End") {
			nextIndex = rows.length - 1;
		} else if (event.key === "ArrowDown") {
			nextIndex = index < 0 ? 0 : Math.min(rows.length - 1, index + 1);
		} else if (event.key === "ArrowUp") {
			nextIndex = index < 0 ? rows.length - 1 : Math.max(0, index - 1);
		}

		if (nextIndex !== index && rows[nextIndex]) {
			event.preventDefault();
			rows[nextIndex].focus();
		}
	});

	window.addEventListener(
		"resize",
		() => {
			if (isOpen()) {
				positionPanel();
			}
		},
		{ passive: true },
	);

	window.addEventListener(
		"scroll",
		() => {
			if (isOpen()) {
				positionPanel();
			}
		},
		{ passive: true },
	);
})();
