/**
 * Content script.
 *
 * Left-clicking a direct link to a video file (or a <video>/<audio> element)
 * pops up a small menu with an "Open in MultiAudio Player" entry instead of
 * navigating away right away.
 */

(() => {
	const VIDEO_EXTENSIONS = new Set([
		'mkv', 'mp4', 'm4v', 'mpg', 'mpeg', 'mpe', 'm2v', 'mov', 'qt', 'webm', 'avi', 'wmv', 'flv',
		'f4v', 'ogv', '3gp', '3g2', 'ts', 'm2ts', 'mts', 'vob', 'rm', 'rmvb', 'asf', '3g2', 'm4a',
		'mp3', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wma',
	]);

	/** @type {{ host: HTMLElement, shadow: ShadowRoot } | null} */
	let popup = null;
	let allowNextClick = false;

	function isVideoUrl(url) {
		if (!url) return false;
		if (/^(blob|data|javascript|about|chrome|extension):/i.test(url)) return false;
		try {
			const parsed = new URL(url, location.href);
			if (!/^(https?|file):$/.test(parsed.protocol)) return false;
			const name = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
			const dot = name.lastIndexOf('.');
			if (dot === -1) return false;
			return VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
		} catch {
			return false;
		}
	}

	function fileNameFromUrl(url) {
		try {
			const parsed = new URL(url, location.href);
			const last = parsed.pathname.split('/').filter(Boolean).pop();
			return last ? decodeURIComponent(last) : parsed.hostname;
		} catch {
			return 'video';
		}
	}

	function closePopup() {
		popup?.host.remove();
		popup = null;
	}

	function openPopup(url, x, y) {
		closePopup();

		const host = document.createElement('div');
		host.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;';
		const shadow = host.attachShadow({ mode: 'open' });

		shadow.innerHTML = `
			<style>
				:host { all: initial; }
				.menu {
					position: fixed;
					min-width: 232px;
					padding: 6px;
					border-radius: 12px;
					background: #12151d;
					border: 1px solid #2b3240;
					box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
					font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif;
					color: #e7ecf3;
					user-select: none;
				}
				.head {
					display: flex; align-items: center; gap: 8px;
					padding: 7px 9px 8px;
					border-bottom: 1px solid rgba(255,255,255,0.08);
					margin-bottom: 4px;
				}
				.dot {
					width: 22px; height: 22px; border-radius: 7px; flex: 0 0 auto;
					background: linear-gradient(135deg, #4f8cff, #9d6bff 60%, #35d0ba);
				}
				.title { font-size: 12px; font-weight: 600; color: #e7ecf3; }
				.sub {
					font-size: 10.5px; color: #7c8698; margin-top: 1px;
					overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px;
				}
				button {
					display: flex; align-items: center; gap: 9px;
					width: 100%; padding: 8px 9px; border: 0; border-radius: 8px;
					background: transparent; color: #e7ecf3; cursor: pointer;
					font: inherit; text-align: left;
				}
				button:hover { background: rgba(79,140,255,0.16); }
				button.primary { background: #4f8cff; color: #fff; font-weight: 600; }
				button.primary:hover { background: #6ea1ff; }
				button .ico { width: 16px; text-align: center; opacity: .9; }
				.hint {
					padding: 6px 9px 3px; font-size: 10.5px; color: #6b7688;
					border-top: 1px solid rgba(255,255,255,0.06); margin-top: 4px;
				}
			</style>
			<div class="menu" role="menu">
				<div class="head">
					<div class="dot"></div>
					<div>
						<div class="title">Video link</div>
						<div class="sub" title=""></div>
					</div>
				</div>
				<button class="primary" data-action="player" role="menuitem">
					<span class="ico">▶</span> Open in MultiAudio Player
				</button>
				<button data-action="normal" role="menuitem">
					<span class="ico">↗</span> Open normally
				</button>
				<button data-action="copy" role="menuitem">
					<span class="ico">⧉</span> Copy link
				</button>
				<div class="hint">Esc to dismiss</div>
			</div>
		`;

		document.documentElement.appendChild(host);
		popup = { host, shadow };

		const name = fileNameFromUrl(url);
		const label = shadow.querySelector('.sub');
		if (label) {
			label.textContent = name;
			label.setAttribute('title', url);
		}

		const menu = shadow.querySelector('.menu');
		const rect = menu.getBoundingClientRect();
		const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
		const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;

		shadow.querySelector('[data-action="player"]').addEventListener('click', (event) => {
			event.stopPropagation();
			closePopup();
			chrome.runtime.sendMessage({ type: 'open-in-player', url, name }, () => void chrome.runtime.lastError);
		});

		shadow.querySelector('[data-action="normal"]').addEventListener('click', (event) => {
			event.stopPropagation();
			closePopup();
			allowNextClick = true;
			if (lastAnchor) lastAnchor.click();
			else location.href = url;
		});

		shadow.querySelector('[data-action="copy"]').addEventListener('click', async (event) => {
			event.stopPropagation();
			try {
				await navigator.clipboard.writeText(url);
			} catch {
				/* clipboard may be unavailable */
			}
			closePopup();
		});
	}

	let lastAnchor = null;

	document.addEventListener(
		'click',
		(event) => {
			if (allowNextClick) {
				allowNextClick = false;
				return;
			}

			if (popup && !event.composedPath().includes(popup.host)) {
				closePopup();
			}

			if (event.button !== 0) return;
			if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

			const target = event.target;
			if (!(target instanceof Element)) return;

			const anchor = target.closest('a[href]');
			if (anchor instanceof HTMLAnchorElement) {
				const href = anchor.href;
				if (!isVideoUrl(href)) return;
				event.preventDefault();
				event.stopPropagation();
				lastAnchor = anchor;
				const rect = anchor.getBoundingClientRect();
				openPopup(href, rect.left, rect.bottom + 6);
				return;
			}

			const media = target.closest('video, audio');
			if (media instanceof HTMLMediaElement) {
				const src = media.currentSrc || media.src;
				if (!isVideoUrl(src)) return;
				event.preventDefault();
				event.stopPropagation();
				const rect = media.getBoundingClientRect();
				openPopup(src, rect.left, rect.bottom + 6);
			}
		},
		true,
	);

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && popup) {
			event.stopPropagation();
			closePopup();
		}
	}, true);

	window.addEventListener('scroll', closePopup, true);
	window.addEventListener('resize', closePopup);

	// The player page can ask the extension to open a URL for it. This is how the
	// hosted site gets around the browser's CORS and mixed-content rules.
	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data || data.source !== 'multiaudio-player') return;

		if (data.type === 'ping') {
			window.postMessage({ source: 'multiaudio-player', type: 'pong' }, '*');
			return;
		}

		if (data.type === 'open-in-player' && data.url) {
			chrome.runtime.sendMessage(
				{ type: 'open-in-player', url: data.url, name: data.name },
				() => void chrome.runtime.lastError,
			);
		}
	});

	// Announce that the extension is available on this page.
	window.postMessage({ source: 'multiaudio-player', type: 'ready' }, '*');
})();
