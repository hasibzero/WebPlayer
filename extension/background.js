/**
 * Background service worker.
 *
 * Responsibilities:
 *  - register the right-click context menu entry,
 *  - open the bundled player in a new tab for a given media URL,
 *  - forward requests coming from the content script.
 */

const PLAYER_PAGE = 'dist/index.html';

/** Extensions we treat as "direct video links". */
export const VIDEO_EXTENSIONS = [
	'mkv',
	'mp4',
	'm4v',
	'mpg',
	'mpeg',
	'mpe',
	'm2v',
	'mov',
	'qt',
	'webm',
	'avi',
	'wmv',
	'flv',
	'f4v',
	'ogv',
	'3gp',
	'3g2',
	'ts',
	'm2ts',
	'mts',
	'vob',
	'rm',
	'rmvb',
	'asf',
	'dvr-ms',
	'mkv',
	'm4a',
	'mp3',
	'aac',
	'flac',
	'ogg',
	'oga',
	'opus',
	'wav',
	'wma',
];

const VIDEO_EXTENSION_PATTERN = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i');

/** Returns true when the URL looks like a direct link to a media file. */
export function isVideoUrl(url) {
	if (!url) return false;
	if (/^(blob|data|javascript|about|chrome):/i.test(url)) return false;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
			return false;
		}
		return VIDEO_EXTENSION_PATTERN.test(parsed.pathname);
	} catch {
		return false;
	}
}

/** Derives a readable file name from a URL. */
export function fileNameFromUrl(url) {
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split('/').filter(Boolean).pop();
		if (!last) return parsed.hostname;
		return decodeURIComponent(last);
	} catch {
		return 'video';
	}
}

/** Opens the bundled player in a new tab, pre-filled with the given URL. */
export function openInPlayer(url, name) {
	const params = new URLSearchParams({ url });
	if (name) params.set('name', name);

	const playerUrl = `${chrome.runtime.getURL(PLAYER_PAGE)}?${params.toString()}`;
	chrome.tabs.create({ url: playerUrl });
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'open-in-multiaudio-player',
			title: 'Open in MultiAudio Player',
			contexts: ['link', 'video', 'audio'],
		});
	});
});

chrome.runtime.onStartup?.addListener(() => {
	// The context menu is re-created on every browser start.
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'open-in-multiaudio-player',
			title: 'Open in MultiAudio Player',
			contexts: ['link', 'video', 'audio'],
		});
	});
});

chrome.contextMenus.onClicked.addListener((info) => {
	const url = info.mediaUrl || info.linkUrl || info.pageUrl;
	if (!url) return;
	openInPlayer(url, fileNameFromUrl(url));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || message.type !== 'open-in-player') return undefined;
	if (!message.url) return undefined;

	openInPlayer(message.url, message.name || fileNameFromUrl(message.url));
	sendResponse({ ok: true });
	return true;
});
