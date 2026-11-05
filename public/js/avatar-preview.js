(() => {
	const wrap = document.querySelector(".avatar-preview-wrap");
	if (!wrap) {
		return;
	}

	const button = wrap.querySelector(".avatar-preview-btn");
	const preview = wrap.querySelector(".avatar-preview");
	if (!button || !preview) {
		return;
	}

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let closeToken = 0;

	function isOpen() {
		return wrap.classList.contains("is-open");
	}

	function positionPreview() {
		const size = preview.offsetWidth || 180;
		const btnRect = button.getBoundingClientRect();
		const gutter = 12;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		let left = 0;
		const overflowRight = btnRect.left + left + size + gutter - viewportWidth;
		if (overflowRight > 0) {
			left -= overflowRight;
		}
		const overflowLeft = btnRect.left + left - gutter;
		if (overflowLeft < 0) {
			left -= overflowLeft;
		}

		const spaceBelow = viewportHeight - btnRect.bottom - gutter;
		const spaceAbove = btnRect.top - gutter;
		const openAbove = spaceBelow < size + 8 && spaceAbove > spaceBelow;

		preview.style.setProperty("--avatar-preview-left", `${Math.round(left)}px`);
		preview.dataset.placement = openAbove ? "above" : "below";
	}

	function openPreview() {
		closeToken += 1;
		wrap.classList.add("is-open");
		button.setAttribute("aria-expanded", "true");
		preview.hidden = false;
		positionPreview();
		if (!reduceMotion.matches) {
			requestAnimationFrame(() => {
				if (isOpen()) {
					wrap.classList.add("is-visible");
				}
			});
		} else {
			wrap.classList.add("is-visible");
		}
	}

	// options.restoreFocus: return focus to the button after close (e.g. Escape).
	// This file is Nunjucks-included; do not use double-brace sequences here.
	function closePreview(options) {
		if (!isOpen()) {
			return;
		}
		const restoreFocus = Boolean(options && options.restoreFocus);
		const token = ++closeToken;
		wrap.classList.remove("is-visible");
		button.setAttribute("aria-expanded", "false");

		const finish = () => {
			if (token !== closeToken) {
				return;
			}
			wrap.classList.remove("is-open");
			preview.hidden = true;
			preview.removeAttribute("data-placement");
			preview.style.removeProperty("--avatar-preview-left");
			// Restore focus after the panel is fully hidden so AT/focus order stay stable.
			if (restoreFocus) {
				button.focus();
			}
		};

		if (reduceMotion.matches) {
			finish();
			return;
		}

		window.setTimeout(finish, 160);
	}

	function togglePreview() {
		if (isOpen()) {
			closePreview();
		} else {
			openPreview();
		}
	}

	button.addEventListener("click", (event) => {
		event.stopPropagation();
		togglePreview();
	});

	document.addEventListener("click", (event) => {
		if (!isOpen()) {
			return;
		}
		if (!event.target.closest(".avatar-preview-wrap")) {
			closePreview();
		}
	});

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !isOpen()) {
			return;
		}
		event.preventDefault();
		// Keyboard dismiss: return focus to the control that opened the preview.
		closePreview({ restoreFocus: true });
	});

	window.addEventListener(
		"resize",
		() => {
			if (isOpen()) {
				positionPreview();
			}
		},
		{ passive: true },
	);

	window.addEventListener(
		"scroll",
		() => {
			if (isOpen()) {
				positionPreview();
			}
		},
		{ passive: true },
	);
})();
