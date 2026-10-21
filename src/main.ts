import './styles.css';

import { MediaPlayer } from './player.ts';
import { PlayerUI } from './ui.ts';
import { readMkvChapters } from './mkv.ts';
import { parseSubtitleText, SubtitleRenderer, type SubtitleTrack } from './subtitles.ts';
import { codecName, formatBytes, formatTime, languageName } from './format.ts';

const canvas = document.getElementById('video-canvas') as HTMLCanvasElement;
const subtitleOverlay = document.getElementById('subtitle-overlay') as HTMLDivElement;

const player = new MediaPlayer(canvas);
const subtitleRenderer = new SubtitleRenderer(subtitleOverlay);

let lastErrorMessage = '';
let currentMediaUrl = '';
player.on('error', (error) => {
	lastErrorMessage = error instanceof Error ? error.message : String(error);
});

let playlist: File[] = [];
let playlistIndex = -1;
let currentMediaName = '';
let subtitleTracks: SubtitleTrack[] = [];
let activeSubtitleId: string | null = null;
let subtitleCounter = 0;

const ui = new PlayerUI(player, {
	onOpenFile: () => fileInput.click(),
	onOpenUrl: () => {
		const url = window.prompt('Enter the URL of a media file (the server must allow CORS):', '');
		if (url) void openUrl(url);
	},
	onLoadSubtitles: () => subtitleInput.click(),
	onSelectSubtitle: (id) => selectSubtitle(id),
	onToggleSubtitles: () => toggleSubtitles(),
	onCloseMedia: () => closeMedia(),
	onPrevious: () => stepPlaylist(-1),
	onNext: () => stepPlaylist(1),
});

/* ------------------------------------------------------------- subtitles */

function selectSubtitle(id: string | null): void {
	if (id === null) {
		activeSubtitleId = null;
		subtitleRenderer.clear();
	} else {
		const track = subtitleTracks.find((item) => item.id === id);
		if (!track) return;
		activeSubtitleId = id;
		subtitleRenderer.setTrack(track.cues);
	}
	ui.renderSubtitles(subtitleTracks, activeSubtitleId);
}

function toggleSubtitles(): void {
	if (activeSubtitleId !== null) {
		selectSubtitle(null);
		return;
	}
	const first = subtitleTracks[0];
	if (first) {
		selectSubtitle(first.id);
	} else {
		ui.toast('No subtitles loaded yet — use "Load subtitle file".');
	}
}

async function addSubtitleFiles(files: File[]): Promise<void> {
	for (const file of files) {
		try {
			const text = await file.text();
			const cues = parseSubtitleText(text);
			if (!cues.length) {
				ui.toast(`No cues found in ${file.name}.`, true);
				continue;
			}
			subtitleCounter += 1;
			subtitleTracks.push({
				id: `sub-${subtitleCounter}`,
				name: file.name.replace(/\.[^.]+$/, ''),
				language: 'und',
				cues,
			});
		} catch (error) {
			ui.toast(`Could not read ${file.name}.`, true);
			console.warn(error);
		}
	}
	ui.renderSubtitles(subtitleTracks, activeSubtitleId);
	if (activeSubtitleId === null && subtitleTracks.length) {
		selectSubtitle(subtitleTracks[0].id);
	}
}

/* ---------------------------------------------------------------- files */

const fileInput = document.getElementById('file-input') as HTMLInputElement;
const subtitleInput = document.getElementById('subtitle-input') as HTMLInputElement;

fileInput.addEventListener('change', () => {
	const files = Array.from(fileInput.files ?? []);
	if (files.length) {
		playlist = files;
		playlistIndex = 0;
		void openFile(files[0]);
	}
	fileInput.value = '';
});

subtitleInput.addEventListener('change', () => {
	const files = Array.from(subtitleInput.files ?? []);
	if (files.length) void addSubtitleFiles(files);
	subtitleInput.value = '';
});

async function openFile(file: File): Promise<void> {
	playlistIndex = playlist.indexOf(file);
	currentMediaName = file.name;
	ui.setStatus(`Opening ${file.name}…`);
	ui.setLoading(true, `Opening ${file.name}…`);

	selectSubtitle(null);
	ui.renderChapters([]);

	await player.load(file, file.name);

	if (!player.isLoaded) return;

	const video = player.videoTrackInfos.find((track) => track.index === player.activeVideoIndexValue);
	const audioStates = player.audioChannelStates;

	ui.setMediaTitle(file.name, describeCurrentMedia());
	ui.setBadges([
		video ? `${video.displayWidth}×${video.displayHeight}` : 'Audio only',
		video ? codecName(video.codec) : '',
		`${audioStates.length} audio track${audioStates.length === 1 ? '' : 's'}`,
		formatTime(player.duration),
	].filter(Boolean));

	const summary = await player.readSummary(file, file.name);
	const info: Array<[string, string]> = [
		['File', file.name],
		['Size', formatBytes(file.size)],
		['Container', summary.container ?? 'Unknown'],
		['Duration', formatTime(player.duration)],
		['Video', video ? `${codecName(video.codec)} · ${video.displayWidth}×${video.displayHeight}` : '—'],
		['Audio tracks', String(audioStates.length)],
	];
	for (const [key, value] of Object.entries(summary.tags)) {
		if (info.length < 12) info.push([key, value]);
	}
	ui.setMediaInfo(info);

	if (/\.(mkv|mka|webm)$/i.test(file.name)) {
		void readMkvChapters(file, player.duration)
			.then((chapters) => {
				ui.renderChapters(chapters);
			})
			.catch(() => ui.renderChapters([]));
	}

	ui.setStatus(`${file.name} · ${formatBytes(file.size)}`);
	void player.play();
}

function describeCurrentMedia(): string {
	const video = player.videoTrackInfos.find((track) => track.index === player.activeVideoIndexValue);
	const enabled = player.audioChannelStates.filter((channel) => channel.enabled);
	const parts: string[] = [];
	if (video) parts.push(`${codecName(video.codec)} ${video.displayWidth}×${video.displayHeight}`);
	if (enabled.length === 1) {
		const info = enabled[0].info;
		parts.push(`${languageName(info.language)} ${codecName(info.codec)}`);
	} else if (enabled.length > 1) {
		parts.push(`${enabled.length} tracks mixed`);
	}
	return parts.join(' · ');
}

const MODE_LABELS: Record<string, string> = {
	local: 'Local file',
	ranged: 'Streamed (range requests)',
	cached: 'Cached in memory',
	downloaded: 'Downloaded',
};

/** Keeps the badges and the info panel in sync with the loaded media. */
function refreshMediaDetails(): void {
	if (!player.isLoaded) return;

	const video = player.videoTrackInfos.find((track) => track.index === player.activeVideoIndexValue);
	const audioCount = player.audioChannelStates.length;

	const badges: string[] = [];
	const resolution = player.effectiveResolution;
	if (resolution.width) {
		badges.push(
			resolution.scaled
				? `${resolution.width}×${resolution.height} (scaled)`
				: `${resolution.sourceWidth}×${resolution.sourceHeight}`,
		);
	}
	badges.push(`${audioCount} audio track${audioCount === 1 ? '' : 's'}`);
	badges.push(formatTime(player.duration));
	ui.setBadges(badges);

	const info: Array<[string, string]> = [
		['File', currentMediaName || 'Media'],
		['Source', MODE_LABELS[player.mode] ?? player.mode],
		['Duration', formatTime(player.duration)],
		['Video', video ? `${codecName(video.codec)} · ${video.displayWidth}×${video.displayHeight}` : '—'],
		['Audio tracks', String(audioCount)],
	];
	if (resolution.scaled) {
		info.push(['Quality', `${resolution.width}×${resolution.height} (scaled)`]);
	}
	if (player.size) info.push(['Size', formatBytes(player.size)]);

	const container = player.containerTrackCounts;
	if (container.total > 0) {
		info.push([
			'In container',
			`${container.video} video, ${container.audio} audio, ${container.subtitle} subtitle`,
		]);
	}

	// The demuxer can miss tracks when a file arrives incomplete.
	if (container.audio > audioCount) {
		info.push(['Missing tracks', `${container.audio - audioCount} audio track(s) not detected`]);
		ui.toast(
			`The file declares ${container.audio} audio tracks but only ${audioCount} could be read. `
			+ 'The download is probably incomplete — use "Re-download & re-scan".',
			true,
		);
	}

	ui.setMediaInfo(info);
}

function closeMedia(): void {
	player.pause();
	ui.setEmptyState(true);
	ui.setLoading(false);
	ui.setStatus('Ready — drop a file to begin.');
	ui.setMediaInfo([]);
	ui.renderChapters([]);
	selectSubtitle(null);
}

function stepPlaylist(direction: number): void {
	if (playlist.length < 2) return;
	playlistIndex = (playlistIndex + direction + playlist.length) % playlist.length;
	void openFile(playlist[playlistIndex]);
}

/** Set by the extension's content script as soon as it is available. */
let extensionPresent = false;

window.addEventListener('message', (event) => {
	const data = event.data;
	if (!data || data.source !== 'multiaudio-player') return;
	if (data.type === 'ready') extensionPresent = true;
});

/**
 * Asks the browser extension to open the URL for us.
 *
 * The hosted site runs on a normal web origin, so it is bound by the browser's
 * CORS and mixed-content rules. The extension has host permissions and can load
 * any media URL, so when it is installed we hand the URL over to it.
 *
 * @returns Whether the extension took over.
 */
async function openViaExtension(url: string, name?: string): Promise<boolean> {
	// If the extension already announced itself, we can skip the handshake.
	if (extensionPresent) {
		window.postMessage({ source: 'multiaudio-player', type: 'open-in-player', url, name }, '*');
		return true;
	}

	const ask = (): Promise<boolean> =>
		new Promise((resolve) => {
			let settled = false;
			const finish = (result: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				window.removeEventListener('message', onMessage);
				resolve(result);
			};

			const onMessage = (event: MessageEvent) => {
				const data = event.data;
				if (!data || data.source !== 'multiaudio-player') return;
				if (data.type !== 'pong') return;
				finish(true);
				window.postMessage(
					{ source: 'multiaudio-player', type: 'open-in-player', url, name },
					'*',
				);
			};

			const timer = window.setTimeout(() => finish(false), 500);
			window.addEventListener('message', onMessage);
			window.postMessage({ source: 'multiaudio-player', type: 'ping' }, '*');
		});

	// The content script may not be injected yet when the page loads, so try a
	// few times before giving up.
	for (let attempt = 0; attempt < 4; attempt++) {
		if (await ask()) return true;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	return false;
}

async function openUrl(url: string, name?: string): Promise<void> {
	currentMediaUrl = url;

	// The extension can load URLs that the page itself is not allowed to.
	// (The extension's own player page is exempt — it can already load them.)
	const isExtensionPage = location.protocol === 'chrome-extension:';
	if (!isExtensionPage && (await openViaExtension(url, name))) {
		ui.toast('Opening in the MultiAudio Player extension…');
		ui.setStatus('Handed over to the extension');
		return;
	}

	ui.setLoading(true, 'Opening URL…');
	ui.setStatus(`Opening ${url}…`);

	const loaded = await player.load(url, name ?? fileNameFromUrl(url), {
		requestInit: requestInitForUrl(),
	});

	if (!loaded) {
		ui.setLoading(false);
		ui.toast(describeUrlError(), true);
		ui.setStatus('Could not open the URL');
		return;
	}

	ui.setEmptyState(false);
	currentMediaName = name ?? fileNameFromUrl(url);
	ui.setMediaTitle(currentMediaName, 'Remote source');
	ui.setStatus(`Streaming ${url}`);

	if (player.mode === 'downloaded') {
		ui.toast('This server does not support range requests — the file was downloaded first so that seeking works.');
	} else if (player.mode === 'cached') {
		ui.toast('This server does not support range requests — the file is cached in memory so that seeking works.');
	}

	void player.play();
}

/** Extension pages may send cookies; regular web pages must not. */
function requestInitForUrl(): RequestInit | undefined {
	const isExtension = location.protocol === 'chrome-extension:';
	return isExtension ? { credentials: 'include' } : undefined;
}

function describeUrlError(): string {
	const message = lastErrorMessage;
	lastErrorMessage = '';

	// A page served over HTTPS cannot load an HTTP resource — the browser
	// blocks it as mixed content before the request even goes out.
	if (location.protocol === 'https:' && /^http:\/\//i.test(currentMediaUrl)) {
		return 'This page is served over HTTPS, so the browser refuses to load an HTTP:// video '
			+ '(mixed content). Use the browser extension, or an HTTPS:// link.';
	}

	if (/cors|cross-origin|failed to fetch|networkerror|load failed|mixed content/i.test(message)) {
		return 'The server refused the request (CORS). Install the browser extension to bypass this restriction.';
	}
	return `Could not open that URL: ${message || 'unknown error'}`;
}

function fileNameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split('/').filter(Boolean).pop();
		return last ? decodeURIComponent(last) : parsed.hostname;
	} catch {
		return url;
	}
}

/* -------------------------------------------------------------- dragging */

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
	event.preventDefault();
	dragDepth += 1;
	document.body.classList.add('dragging');
});

window.addEventListener('dragover', (event) => {
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) document.body.classList.remove('dragging');
});

window.addEventListener('drop', (event) => {
	event.preventDefault();
	dragDepth = 0;
	document.body.classList.remove('dragging');

	const files = Array.from(event.dataTransfer?.files ?? []);
	if (!files.length) return;

	const media = files.filter((file) => file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|mpg|mpeg|flv|wmv|ogv|3gp|mkv)$/i.test(file.name));
	const sidecars = files.filter((file) => /\.(srt|vtt|ass|ssa)$/i.test(file.name));

	if (sidecars.length) void addSubtitleFiles(sidecars);
	if (media.length) {
		playlist = media;
		playlistIndex = 0;
		void openFile(media[0]);
	}
});

/* ----------------------------------------------------------------- loop */

player.on('timeupdate', (time) => {
	if (activeSubtitleId !== null) subtitleRenderer.update(time as number);
});

player.on('subtitles', (payload) => {
	const embedded = payload as SubtitleTrack[];

	subtitleTracks = subtitleTracks.filter((track) => track.source !== 'embedded');
	for (const track of embedded) {
		subtitleTracks.push({ ...track, source: 'embedded' });
	}

	ui.renderSubtitles(subtitleTracks, activeSubtitleId);

	if (activeSubtitleId === null) {
		const first = subtitleTracks[0];
		if (first) selectSubtitle(first.id);
	} else {
		// The cues keep arriving while the file is being scanned.
		const active = subtitleTracks.find((track) => track.id === activeSubtitleId);
		if (active) subtitleRenderer.setTrack(active.cues);
	}
});

player.on('trackschange', () => {
	if (player.isLoaded) {
		ui.setMediaTitle(currentMediaName || 'Media', describeCurrentMedia());
	}
});

player.on('scan', () => {
	refreshMediaDetails();
});

player.on('ready', () => {
	refreshMediaDetails();
});

ui.setEmptyState(true);
ui.setStatus('Ready — drop a file to begin.');

// Exposed for debugging and automated tests.
(window as unknown as Record<string, unknown>).__player = player;
(window as unknown as Record<string, unknown>).__ui = ui;

// The extension opens the player with ?url=… (and optionally &name=…).
const query = new URLSearchParams(location.search);
const queryUrl = query.get('url');
if (queryUrl) {
	ui.setEmptyState(false);
	void openUrl(queryUrl, query.get('name') ?? undefined);
}
