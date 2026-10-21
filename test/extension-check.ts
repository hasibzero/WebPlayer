/**
 * End-to-end test for the browser extension:
 *  1. serves a page with a direct video link (no CORS headers on purpose),
 *  2. loads the unpacked extension in Chrome,
 *  3. left-clicks the link and expects the "Open in MultiAudio Player" menu,
 *  4. opens the player from the menu and verifies the video actually plays.
 *
 * Run with: node --experimental-strip-types test/extension-check.ts
 */
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME_CANDIDATES = [
	process.env.BROWSER_PATH,
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter((value): value is string => Boolean(value));

// Google Chrome 137+ refuses `--load-extension`; Edge still honours it.
const CHROME = CHROME_CANDIDATES.find((path) => existsSync(path)) ?? CHROME_CANDIDATES[0];
const EXTENSION_DIR = resolve('extension');
const FIXTURE = resolve('test/fixtures/multi-audio.mkv');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
	}
}

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Link test page</title></head>
<body style="font: 16px sans-serif; padding: 40px">
	<h1>Test page</h1>
	<p><a id="video-link" href="/media/multi-audio.mkv">Download the multi-audio MKV</a></p>
	<p><a id="page-link" href="/other.html">An ordinary link</a></p>
	<p><a id="mp4-link" href="/media/movie.mp4">An mp4 file</a></p>
</body></html>`;

let server: Server;
const { port } = await new Promise<{ port: number }>((resolvePromise) => {
	server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (url.pathname === '/') {
			response.writeHead(200, { 'Content-Type': 'text/html' });
			response.end(pageHtml);
			return;
		}
		if (url.pathname === '/media/multi-audio.mkv') {
			const data = await readFile(FIXTURE);
			// Deliberately no CORS headers: only the extension can fetch this.
			// This endpoint does support range requests.
			const range = request.headers.range;
			const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
			if (match) {
				const start = Number(match[1]);
				const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
				const slice = data.subarray(start, end + 1);
				response.writeHead(206, {
					'Content-Type': 'video/x-matroska',
					'Content-Range': `bytes ${start}-${end}/${data.length}`,
					'Content-Length': String(slice.length),
					'Accept-Ranges': 'bytes',
				});
				response.end(slice);
				return;
			}
			response.writeHead(200, {
				'Content-Type': 'video/x-matroska',
				'Content-Length': String(data.length),
				'Accept-Ranges': 'bytes',
			});
			response.end(data);
			return;
		}
		if (url.pathname === '/liar/multi-audio.mkv') {
			// A host that claims range support (206) but always sends the first bytes.
			const data = await readFile(FIXTURE);
			const range = request.headers.range;
			const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
			const requestedStart = match ? Number(match[1]) : 0;
			const requestedEnd = match && match[2] ? Number(match[2]) : data.length - 1;
			const slice = data.subarray(0, Math.min(data.length, requestedEnd - requestedStart + 1));
			response.writeHead(206, {
				'Content-Type': 'video/x-matroska',
				'Content-Range': `bytes ${requestedStart}-${requestedEnd}/${data.length}`,
				'Content-Length': String(slice.length),
			});
			response.end(slice);
			return;
		}
		if (url.pathname === '/norange/multi-audio.mkv') {
			// A server that ignores Range headers and always answers with 200.
			const data = await readFile(FIXTURE);
			response.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': String(data.length) });
			response.end(data);
			return;
		}
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
	});
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();
		resolvePromise({ port: typeof address === 'object' && address ? address.port : 0 });
	});
});

const base = `http://127.0.0.1:${port}`;
console.log(`\n== serving test page on ${base} ==`);

const browser: Browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	args: [
		'--no-sandbox',
		'--disable-gpu',
		'--use-gl=swiftshader',
		`--disable-extensions-except=${EXTENSION_DIR}`,
		`--load-extension=${EXTENSION_DIR}`,
		'--autoplay-policy=no-user-gesture-required',
	],
});

try {
	// Give the service worker a moment to register.
	await new Promise((r) => setTimeout(r, 1500));

	const workerTarget = browser.targets().find((target) => target.type() === 'service_worker');
	check('extension service worker running', Boolean(workerTarget), workerTarget?.url() ?? 'none');
	const extensionId = workerTarget?.url().split('/')[2] ?? '';
	check('extension id resolved', extensionId.length > 0, extensionId);

	const page: Page = await browser.newPage();
	await page.setViewport({ width: 1200, height: 800 });
	await page.goto(base, { waitUntil: 'networkidle2' });

	console.log('\n== left-click interception ==');
	await page.click('#video-link');
	await new Promise((r) => setTimeout(r, 500));

	const popupInfo = await page.evaluate(() => {
		const host = Array.from(document.querySelectorAll('div')).find((node) => node.shadowRoot?.querySelector('.menu'));
		const menu = host?.shadowRoot?.querySelector('.menu') as HTMLElement | undefined;
		if (!menu) return null;
		const buttons = Array.from(menu.querySelectorAll('button')).map((button) => ({
			action: button.getAttribute('data-action'),
			text: button.textContent?.trim(),
		}));
		return {
			title: menu.querySelector('.sub')?.textContent,
			buttons,
			visible: menu.getBoundingClientRect().width > 0,
		};
	});
	console.log('  popup:', JSON.stringify(popupInfo));
	check('menu appeared on left click', popupInfo !== null);
	check('menu has the player entry', popupInfo?.buttons.some((b) => b.text?.includes('Open in MultiAudio Player')), JSON.stringify(popupInfo?.buttons));
	check('menu shows the file name', popupInfo?.title === 'multi-audio.mkv', String(popupInfo?.title));
	await page.screenshot({ path: resolve('test/screenshots/05-link-menu.png') });

	console.log('\n== ordinary links are untouched ==');
	await page.keyboard.press('Escape');
	await new Promise((r) => setTimeout(r, 300));
	await page.click('#page-link');
	await new Promise((r) => setTimeout(r, 700));
	const navigated = page.url();
	check('non-video link navigates normally', navigated.endsWith('/other.html'), navigated);

	console.log('\n== opening in the player ==');
	await page.goto(base, { waitUntil: 'networkidle2' });
	await page.click('#video-link');
	await new Promise((r) => setTimeout(r, 400));

	const pagesBefore = (await browser.pages()).length;
	await page.evaluate(() => {
		const host = Array.from(document.querySelectorAll('div')).find((node) => node.shadowRoot?.querySelector('.menu'));
		const button = host?.shadowRoot?.querySelector('[data-action="player"]') as HTMLElement | undefined;
		button?.click();
	});
	await new Promise((r) => setTimeout(r, 2500));

	const pages = await browser.pages();
	check('a new tab was opened', pages.length > pagesBefore, `${pagesBefore} -> ${pages.length}`);

	const playerPage = pages.find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`));
	check('player tab is the extension page', Boolean(playerPage), pages.map((p) => p.url()).join(' | '));

	if (playerPage) {
		await playerPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
		const state = await playerPage.evaluate(() => {
			const player = (window as any).__player;
			return {
				mode: player.mode,
				audioCount: player.audioChannelStates.length,
				langs: player.audioChannelStates.map((state: any) => state.info.language),
				playing: player.isPlaying,
				time: player.getMediaTime(),
				duration: player.duration,
				decoded: player.audioDecodeCounts,
			};
		});
		console.log('  player state:', JSON.stringify(state));
		check('remote MKV loaded', state.audioCount === 3, String(state.audioCount));
		check('range-supported server is used directly', state.mode === 'ranged', state.mode);
		check('remote audio tracks detected', state.langs.join(',') === 'eng,jpn,spa', state.langs.join(','));
		check('remote file is playing', state.playing === true);
		check('remote playback advances', state.time > 0.4, String(state.time));
		check('default track decodes', state.decoded[0] > 0, JSON.stringify(state.decoded));

		// Enable every track and make sure all of them decode from the network.
		const mixed = await playerPage.evaluate(async () => {
			const player = (window as any).__player;
			await player.setAudioTrackEnabled(1, true);
			await player.setAudioTrackEnabled(2, true);
			await new Promise((resolve) => setTimeout(resolve, 2000));
			return { decoded: player.audioDecodeCounts, enabled: player.audioChannelStates.map((s: any) => s.enabled) };
		});
		console.log('  mixed state:', JSON.stringify(mixed));
		check('all remote tracks enabled', mixed.enabled.every(Boolean), JSON.stringify(mixed.enabled));
		check('all remote tracks decode', mixed.decoded.every((count: number) => count > 0), JSON.stringify(mixed.decoded));

		await new Promise((r) => setTimeout(r, 1200));
		const later = await playerPage.evaluate(() => (window as any).__player.getMediaTime());
		check('playhead keeps moving', later > state.time, `${state.time} -> ${later}`);

		await playerPage.screenshot({ path: resolve('test/screenshots/04-extension-player.png') });
	}

	console.log('\n== server without range support ==');
	const noRangePage = await browser.newPage();
	await noRangePage.setViewport({ width: 1200, height: 800 });
	const consoleMessages: string[] = [];
	noRangePage.on('console', (message) => consoleMessages.push(message.text()));

	const noRangeUrl = `chrome-extension://${extensionId}/dist/index.html?url=${encodeURIComponent(`${base}/norange/multi-audio.mkv`)}`;
	await noRangePage.goto(noRangeUrl, { waitUntil: 'networkidle2' });
	await noRangePage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });

	const noRangeState = await noRangePage.evaluate(async () => {
		const player = (window as any).__player;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		return {
			mode: player.mode,
			size: player.size,
			playing: player.isPlaying,
			time: player.getMediaTime(),
			audioCount: player.audioChannelStates.length,
		};
	});
	console.log('  no-range state:', JSON.stringify(noRangeState));
	check('mode is cached (not ranged)', noRangeState.mode === 'cached', noRangeState.mode);
	check('remote size detected', noRangeState.size === 363136 || (noRangeState.size ?? 0) > 100000, String(noRangeState.size));
	check('no-range file plays', noRangeState.playing === true && noRangeState.time > 0.3, JSON.stringify(noRangeState));
	check('no-range audio tracks detected', noRangeState.audioCount === 3, String(noRangeState.audioCount));

	// Seeking must still work even though the server cannot serve ranges.
	const seekState = await noRangePage.evaluate(async () => {
		const player = (window as any).__player;
		await player.seek(5);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		return { time: player.getMediaTime(), playing: player.isPlaying };
	});
	console.log('  no-range seek:', JSON.stringify(seekState));
	check('seeking works without range support', Math.abs(seekState.time - 5) < 1.5, String(seekState.time));
	check('still playing after seek', seekState.playing === true);

	const rangeWarnings = consoleMessages.filter((text) => /did not respond to a range request/i.test(text));
	check('no range-support warning in console', rangeWarnings.length === 0, rangeWarnings[0] ?? '');

	console.log('\n== server without range support, forced download ==');
	const forcedState = await noRangePage.evaluate(async (url) => {
		const player = (window as any).__player;
		const progress: number[] = [];
		const off = player.on('progress', (payload: any) => progress.push(payload.loaded));
		const ok = await player.load(url, 'multi-audio.mkv', { fullCacheLimit: 0 });
		off();
		if (ok) await player.play();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		return {
			ok,
			mode: player.mode,
			progressEvents: progress.length,
			lastProgress: progress[progress.length - 1] ?? 0,
			playing: player.isPlaying,
			time: player.getMediaTime(),
			audioCount: player.audioChannelStates.length,
		};
	}, `${base}/norange/multi-audio.mkv`);
	console.log('  forced download:', JSON.stringify(forcedState));
	check('download fallback used', forcedState.mode === 'downloaded', forcedState.mode);
	check('progress was reported', forcedState.progressEvents > 1, String(forcedState.progressEvents));
	check('downloaded file is complete', forcedState.lastProgress > 100000, String(forcedState.lastProgress));
	check('downloaded file plays', forcedState.playing === true && forcedState.time > 0.2, JSON.stringify(forcedState));
	check('downloaded file has its tracks', forcedState.audioCount === 3, String(forcedState.audioCount));

	const forcedSeek = await noRangePage.evaluate(async () => {
		const player = (window as any).__player;
		await player.seek(4);
		await new Promise((resolve) => setTimeout(resolve, 900));
		return { time: player.getMediaTime() };
	});
	check('seeking works on the downloaded copy', Math.abs(forcedSeek.time - 4) < 1.5, String(forcedSeek.time));

	console.log('\n== server that lies about range support ==');
	const liarPage = await browser.newPage();
	await liarPage.setViewport({ width: 1200, height: 800 });
	await liarPage.goto(
		`chrome-extension://${extensionId}/dist/index.html?url=${encodeURIComponent(`${base}/liar/multi-audio.mkv`)}`,
		{ waitUntil: 'networkidle2' },
	);
	await liarPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await new Promise((r) => setTimeout(r, 800));

	const liarState = await liarPage.evaluate(() => {
		const player = (window as any).__player;
		return {
			mode: player.mode,
			audioCount: player.audioChannelStates.length,
			langs: player.audioChannelStates.map((state: any) => state.info.language),
			domCards: document.querySelectorAll('#audio-track-list .track-card').length,
			playing: player.isPlaying,
			time: player.getMediaTime(),
		};
	});
	console.log('  liar server:', JSON.stringify(liarState));
	check('lying server is not streamed directly', liarState.mode === 'downloaded', liarState.mode);
	check('all tracks found despite lying server', liarState.audioCount === 3, String(liarState.audioCount));
	check('all tracks listed in the panel', liarState.domCards === 3, String(liarState.domCards));
	check('lying server file plays', liarState.playing === true && liarState.time > 0.2, JSON.stringify(liarState));

	console.log('\n== re-scan button ==');
	const rescanState = await liarPage.evaluate(async () => {
		const button = document.getElementById('btn-rescan') as HTMLButtonElement;
		const visible = !document.getElementById('rescan-actions')?.hidden;
		button.click();
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const player = (window as any).__player;
		return {
			visible,
			mode: player.mode,
			audioCount: player.audioChannelStates.length,
			domCards: document.querySelectorAll('#audio-track-list .track-card').length,
		};
	});
	console.log('  re-scan:', JSON.stringify(rescanState));
	check('re-scan button is offered for remote files', rescanState.visible === true);
	check('re-scan keeps all tracks', rescanState.audioCount === 3 && rescanState.domCards === 3, JSON.stringify(rescanState));
} finally {
	await browser.close();
	server.close();
}

console.log(failures === 0 ? '\nAll extension checks passed.\n' : `\n${failures} extension check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
