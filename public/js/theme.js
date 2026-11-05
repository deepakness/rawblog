(() => {
	const STORAGE_KEY = "theme-preference";
	const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 5;
	const ORDER = ["light", "paper", "dark"];
	const VALID_PREFERENCES = new Set(ORDER);
	const LABELS = {
		light: "Light",
		paper: "Paper",
		dark: "Dark",
	};

	function isValidPreference(value) {
		return typeof value === "string" && VALID_PREFERENCES.has(value);
	}

	function getEffectiveTheme() {
		try {
			return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		} catch (error) {
			return "light";
		}
	}

	function readPreferenceCookie() {
		try {
			const cookies = document.cookie ? document.cookie.split("; ") : [];
			for (const cookie of cookies) {
				if (!cookie.startsWith(`${STORAGE_KEY}=`)) {
					continue;
				}
				const value = decodeURIComponent(cookie.slice(STORAGE_KEY.length + 1));
				return isValidPreference(value) ? value : null;
			}
		} catch (error) {
			return null;
		}
		return null;
	}

	function writePreferenceCookie(preference) {
		try {
			document.cookie =
				`${STORAGE_KEY}=${encodeURIComponent(preference)}; ` +
				`Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
		} catch (error) {
			// Ignore cookie failures.
		}
	}

	function clearStoredPreference() {
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch (error) {
			// Ignore storage failures.
		}

		try {
			document.cookie = `${STORAGE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
		} catch (error) {
			// Ignore cookie failures.
		}
	}

	function getStoredPreference() {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (isValidPreference(stored)) {
				return stored;
			}
			// Drop legacy "system" (and any other invalid value).
			if (stored) {
				clearStoredPreference();
			}
		} catch (error) {
			// Fall back to cookies below if localStorage is unavailable.
		}

		return readPreferenceCookie();
	}

	function applyPreference(preference) {
		const root = document.documentElement;
		if (isValidPreference(preference)) {
			root.setAttribute("data-theme", preference);
		} else {
			root.removeAttribute("data-theme");
		}
	}

	function savePreference(preference) {
		if (!isValidPreference(preference)) {
			clearStoredPreference();
			return;
		}

		try {
			localStorage.setItem(STORAGE_KEY, preference);
		} catch (error) {
			// Ignore storage failures (private mode or blocked storage).
		}

		writePreferenceCookie(preference);
	}

	function getNextPreference(currentPreference) {
		const currentIndex = ORDER.indexOf(currentPreference);
		if (currentIndex === -1) {
			return ORDER[0];
		}
		return ORDER[(currentIndex + 1) % ORDER.length];
	}

	function getDisplayTheme(preference) {
		return isValidPreference(preference) ? preference : getEffectiveTheme();
	}

	function syncCycleButton(button, preference) {
		const displayTheme = getDisplayTheme(preference);
		button.dataset.themeState = displayTheme;
		const currentLabel = LABELS[displayTheme];
		const nextPreference = getNextPreference(displayTheme);
		const nextLabel = LABELS[nextPreference];
		button.setAttribute("aria-label", `Current theme: ${currentLabel}. Activate to switch to ${nextLabel}.`);
		button.setAttribute("title", `Current theme: ${currentLabel}`);
	}

	function initializeThemeCycleButton() {
		const cycleButton = document.querySelector("[data-theme-cycle]");
		if (!cycleButton) {
			return;
		}

		let activePreference = getStoredPreference();

		const setPreference = (preference) => {
			applyPreference(preference);
			savePreference(preference);
			syncCycleButton(cycleButton, preference);
			activePreference = preference;
		};

		applyPreference(activePreference);
		syncCycleButton(cycleButton, activePreference);

		cycleButton.addEventListener("click", () => {
			const current = getDisplayTheme(activePreference);
			setPreference(getNextPreference(current));
		});

		window.addEventListener("storage", (event) => {
			if (event.key !== STORAGE_KEY) {
				return;
			}

			activePreference = getStoredPreference();
			applyPreference(activePreference);
			syncCycleButton(cycleButton, activePreference);
		});

		try {
			const media = window.matchMedia("(prefers-color-scheme: dark)");
			const onSchemeChange = () => {
				if (activePreference) {
					return;
				}
				syncCycleButton(cycleButton, activePreference);
			};
			if (typeof media.addEventListener === "function") {
				media.addEventListener("change", onSchemeChange);
			} else if (typeof media.addListener === "function") {
				media.addListener(onSchemeChange);
			}
		} catch (error) {
			// Ignore matchMedia failures.
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initializeThemeCycleButton, {
			once: true,
		});
	} else {
		initializeThemeCycleButton();
	}
})();
