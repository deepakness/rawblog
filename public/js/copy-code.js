document.addEventListener("DOMContentLoaded", function () {
	const codeBlocks = document.querySelectorAll("pre");

	codeBlocks.forEach(function (codeBlock, index) {
		const wrapper = document.createElement("div");
		wrapper.className = "code-block-wrapper";

		codeBlock.parentNode.insertBefore(wrapper, codeBlock);

		wrapper.appendChild(codeBlock);

		const copyButton = document.createElement("button");
		copyButton.className = "copy-code-btn";
		copyButton.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
        `;
		copyButton.setAttribute("aria-label", "Copy code to clipboard");
		copyButton.setAttribute("title", "Copy code");

		copyButton.addEventListener("click", function () {
			const code = codeBlock.querySelector("code");
			const text = code ? code.textContent : codeBlock.textContent;

			navigator.clipboard
				.writeText(text)
				.then(function () {
					const originalContent = copyButton.innerHTML;
					copyButton.innerHTML = `
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20,6 9,17 4,12"></polyline>
                    </svg>
                `;
					copyButton.classList.add("copied");

					setTimeout(function () {
						copyButton.innerHTML = originalContent;
						copyButton.classList.remove("copied");
					}, 2000);
				})
				.catch(function (err) {
					console.error("Failed to copy: ", err);
					// Fallback for older browsers
					const textArea = document.createElement("textarea");
					textArea.value = text;
					document.body.appendChild(textArea);
					textArea.select();
					try {
						document.execCommand("copy");
						copyButton.innerHTML = `
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20,6 9,17 4,12"></polyline>
                        </svg>
                    `;
						copyButton.classList.add("copied");
						setTimeout(function () {
							copyButton.innerHTML = originalContent;
							copyButton.classList.remove("copied");
						}, 2000);
					} catch (err) {
						console.error("Fallback copy failed: ", err);
					}
					document.body.removeChild(textArea);
				});
		});

		wrapper.appendChild(copyButton);
	});
});
