/**
 * End-to-end browser check: loads a real MKV with several audio tracks in
 * headless Chrome and verifies that video renders, audio decodes and the
 * playhead advances.
 *
 * Run with: node --experimental-strip-types test/browser-check.ts
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const FIXTURE = resolve('test/fixtures/multi-audio.mkv');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
	}
}

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	args: [
		'--autoplay-policy=no-user-gesture-required',
		'--no-sandbox',
		'--disable-gpu',
		'--use-gl=swiftshader',
		'--window-size=1400,900',
	],
});

try {
	const page = await browser.newPage();
	await page.setViewport({ width: 1400, height: 900 });

	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

	await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

	console.log('\n== loading MKV ==');
	const input = await page.$('#file-input');
	if (!input) throw new Error('file input not found');
	await input.uploadFile(FIXTURE);

	// Wait until the player reports that it is loaded.
	await page.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await new Promise((resolve) => setTimeout(resolve, 1500));

	const state = await page.evaluate(async () => {
		const player = (window as any).__player;
		const audioStates = player.audioChannelStates;
		const videoTracks = player.videoTrackInfos;
		return {
			duration: player.duration,
			audioCount: audioStates.length,
			audioLangs: audioStates.map((state: any) => state.info.language),
			audioChannels: audioStates.map((state: any) => state.info.channels),
			enabled: audioStates.map((state: any) => state.enabled),
			videoCount: videoTracks.length,
			videoCodec: videoTracks[0]?.codec ?? null,
			videoDecodable: videoTracks[0]?.decodable ?? false,
			audioDecodable: audioStates.map((state: any) => state.info.decodable),
			playing: player.isPlaying,
			time: player.getMediaTime(),
			uiAudioCards: document.querySelectorAll('#menu-audio .menu-item').length,
			uiVideoCards: document.querySelectorAll('#menu-video .menu-item').length,
		};
	});

	console.log('  state:', JSON.stringify(state));
	check('duration detected', Math.abs(state.duration - 8) < 1, String(state.duration));
	check('three audio tracks', state.audioCount === 3, String(state.audioCount));
	check('languages eng/jpn/spa', state.audioLangs.join(',') === 'eng,jpn,spa', state.audioLangs.join(','));
	check('channel layouts 2/2/6', state.audioChannels.join(',') === '2,2,6', state.audioChannels.join(','));
	check('all audio tracks decodable', state.audioDecodable.every(Boolean), JSON.stringify(state.audioDecodable));
	check('one video track', state.videoCount === 1, String(state.videoCount));
	check('video codec h264/avc', state.videoCodec === 'avc', String(state.videoCodec));
	check('video decodable', state.videoDecodable === true);
	check('audio panel shows 3 cards', state.uiAudioCards === 3, String(state.uiAudioCards));
	check('video panel shows 1 card', state.uiVideoCards === 1, String(state.uiVideoCards));

	console.log('\n== playback ==');
	await page.waitForFunction(() => (window as any).__player?.getMediaTime() > 1, { timeout: 30000 });
	const afterPlay = await page.evaluate(() => {
		const player = (window as any).__player;
		const canvas = document.getElementById('video-canvas') as HTMLCanvasElement;
		const context = canvas.getContext('2d')!;
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let nonBlack = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) nonBlack++;
		}
		return {
			time: player.getMediaTime(),
			playing: player.isPlaying,
			canvasWidth: canvas.width,
			canvasHeight: canvas.height,
			nonBlackPixels: nonBlack,
		};
	});
	console.log('  playback:', JSON.stringify(afterPlay));
	check('playhead advanced', afterPlay.time > 1, String(afterPlay.time));
	check('playing', afterPlay.playing === true);
	check('canvas sized 320x240', afterPlay.canvasWidth === 320 && afterPlay.canvasHeight === 240, `${afterPlay.canvasWidth}x${afterPlay.canvasHeight}`);
	check('video frame rendered', afterPlay.nonBlackPixels > 500, String(afterPlay.nonBlackPixels));

	console.log('\n== multi-audio mixing ==');
	const mixResult = await page.evaluate(async () => {
		const player = (window as any).__player;
		await player.setAudioTrackEnabled(1, true);
		await player.setAudioTrackEnabled(2, true);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const states = player.audioChannelStates;
		return {
			enabled: states.map((state: any) => state.enabled),
			time: player.getMediaTime(),
			decoded: player.audioDecodeCounts,
		};
	});
	console.log('  mix:', JSON.stringify(mixResult));
	check('three tracks enabled', mixResult.enabled.every(Boolean), JSON.stringify(mixResult.enabled));
	check('still playing after mixing', mixResult.time > 2, String(mixResult.time));
	check('every track decoded audio', mixResult.decoded.every((count: number) => count > 0), JSON.stringify(mixResult.decoded));

	console.log('\n== seeking ==');
	const seekResult = await page.evaluate(async () => {
		const player = (window as any).__player;
		await player.seek(5);
		await new Promise((resolve) => setTimeout(resolve, 900));
		return { time: player.getMediaTime() };
	});
	check('seek to 5s', Math.abs(seekResult.time - 5) < 1.2, String(seekResult.time));

	console.log('\n== pause / resume ==');
	const pauseResult = await page.evaluate(async () => {
		const player = (window as any).__player;
		player.pause();
		await new Promise((resolve) => setTimeout(resolve, 400));
		const pausedTime = player.getMediaTime();
		await new Promise((resolve) => setTimeout(resolve, 600));
		const stillPaused = player.getMediaTime();
		return { pausedTime, stillPaused, playing: player.isPlaying };
	});
	check('time frozen while paused', Math.abs(pauseResult.pausedTime - pauseResult.stillPaused) < 0.05, `${pauseResult.pausedTime} -> ${pauseResult.stillPaused}`);
	check('playing flag cleared', pauseResult.playing === false);

	console.log('\n== chapters ==');
	await page.evaluate(() => (window as any).__player.pause());
	const chapterPage = await browser.newPage();
	await chapterPage.setViewport({ width: 1400, height: 900 });
	await chapterPage.goto(BASE_URL, { waitUntil: 'networkidle2' });
	const chapterInput = await chapterPage.$('#file-input');
	await chapterInput!.uploadFile(resolve('test/fixtures/chapters.mkv'));
	await chapterPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await chapterPage.waitForFunction(
		() => document.querySelectorAll('#chapter-list .chapter-row').length > 0,
		{ timeout: 20000 },
	);
	const chapterInfo = await chapterPage.evaluate(() =>
		Array.from(document.querySelectorAll('#chapter-list .chapter-row')).map((item) => ({
			time: item.querySelector('.chapter-time')?.textContent,
			title: item.querySelector('.chapter-title')?.textContent,
		})),
	);
	console.log('  chapters:', JSON.stringify(chapterInfo));
	check('two chapters in the UI', chapterInfo.length === 2, String(chapterInfo.length));
	check('chapter titles', chapterInfo[0]?.title === 'Opening' && chapterInfo[1]?.title === 'Main story', JSON.stringify(chapterInfo));
	check('chapter timestamps', chapterInfo[1]?.time === '0:03', String(chapterInfo[1]?.time));

	console.log('\n== embedded subtitles ==');
	const subPage = await browser.newPage();
	await subPage.setViewport({ width: 1400, height: 900 });
	const subErrors: string[] = [];
	subPage.on('pageerror', (error) => subErrors.push(error.message));
	await subPage.goto(BASE_URL, { waitUntil: 'networkidle2' });
	const subInput = await subPage.$('#file-input');
	await subInput!.uploadFile(resolve('test/fixtures/multi-audio-subs.mkv'));
	await subPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await subPage.waitForFunction(
		() => document.querySelectorAll('#menu-subs .menu-item').length > 0,
		{ timeout: 30000 },
	);

	const subState = await subPage.evaluate(async () => {
		const player = (window as any).__player;
		await player.seek(1.5);
		await new Promise((resolve) => setTimeout(resolve, 700));
		const info = document.getElementById('media-info')?.textContent ?? '';
		return {
			embedded: player.embeddedSubtitles.length,
			cues: player.embeddedSubtitles[0]?.cues.length ?? 0,
			cards: document.querySelectorAll('#menu-subs .menu-item').length,
			overlay: document.getElementById('subtitle-overlay')?.textContent?.trim() ?? '',
			audioCards: document.querySelectorAll('#menu-audio .menu-item').length,
			container: player.containerTrackCounts,
			infoHasContainer: info.includes('In container'),
		};
	});
	console.log('  subtitle state:', JSON.stringify(subState));
	check('embedded subtitle track detected', subState.embedded === 1, String(subState.embedded));
	check('embedded cues extracted', subState.cues === 3, String(subState.cues));
	check('subtitle listed in the menu', subState.cards >= 2, String(subState.cards));
	check('cue rendered on the video', subState.overlay.includes('First subtitle line'), JSON.stringify(subState.overlay));
	check('audio tracks still listed', subState.audioCards === 3, String(subState.audioCards));
	check('container track counts reported', subState.container.audio === 3 && subState.container.subtitle === 1, JSON.stringify(subState.container));
	check('info panel shows container counts', subState.infoHasContainer === true);
	check('no page errors', subErrors.length === 0, subErrors[0] ?? '');

	console.log('\n== tracks flagged as disabled in the file ==');
	const disabledPage = await browser.newPage();
	await disabledPage.setViewport({ width: 1400, height: 900 });
	await disabledPage.goto(BASE_URL, { waitUntil: 'networkidle2' });
	const disabledInput = await disabledPage.$('#file-input');
	await disabledInput!.uploadFile(resolve('test/fixtures/disabled-tracks.mkv'));
	await disabledPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await new Promise((r) => setTimeout(r, 800));

	const disabledState = await disabledPage.evaluate(() => {
		const player = (window as any).__player;
		return {
			enabledTracks: player.enabledTrackCount,
			engineTracks: player.audioChannelStates.length,
			domCards: document.querySelectorAll('#menu-audio .menu-item').length,
			langs: player.audioChannelStates.map((state: any) => state.info.language),
		};
	});
	console.log('  disabled tracks:', JSON.stringify(disabledState));
	check('disabled track was detected and enabled', disabledState.enabledTracks === 1, String(disabledState.enabledTracks));
	check('all three audio tracks are listed', disabledState.engineTracks === 3, String(disabledState.engineTracks));
	check('panel shows all three audio tracks', disabledState.domCards === 3, String(disabledState.domCards));
	check('all languages are shown', disabledState.langs.join(',') === 'eng,jpn,spa', disabledState.langs.join(','));

	console.log('\n== audio track selection ==');
	const selectPage = await browser.newPage();
	await selectPage.setViewport({ width: 1400, height: 900 });
	await selectPage.goto(BASE_URL, { waitUntil: 'networkidle2' });
	const selectInput = await selectPage.$('#file-input');
	await selectInput!.uploadFile(resolve('test/fixtures/multi-audio.mkv'));
	await selectPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await new Promise((r) => setTimeout(r, 800));

	const selection = await selectPage.evaluate(async () => {
		const player = (window as any).__player;
		const items = () => document.querySelectorAll<HTMLElement>('#menu-audio .menu-item');
		const before = {
			items: items().length,
			checked: Array.from(items()).map((item) => item.getAttribute('aria-checked') === 'true'),
			enabled: player.audioChannelStates.map((state: any) => state.enabled),
		};

		// Open the audio menu on the player and pick the third track.
		(document.getElementById('btn-audio-menu') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 150));
		const menuOpen = !(document.getElementById('menu-audio') as HTMLElement).hidden;
		items()[2].click();
		await new Promise((resolve) => setTimeout(resolve, 900));

		return {
			before,
			menuOpen,
			afterEnabled: player.audioChannelStates.map((state: any) => state.enabled),
			afterChecked: Array.from(items()).map((item) => item.getAttribute('aria-checked') === 'true'),
			menuClosed: (document.getElementById('menu-audio') as HTMLElement).hidden,
			label: document.getElementById('audio-menu-label')?.textContent,
		};
	});
	console.log('  selection:', JSON.stringify(selection));
	check('the audio menu lists every track', selection.before.items === 3, String(selection.before.items));
	check('the menu opens on the player', selection.menuOpen === true);
	check('one track is selected by default', selection.before.checked.filter(Boolean).length === 1, JSON.stringify(selection.before.checked));
	check('picking a track deselects the others', selection.afterEnabled.filter(Boolean).length === 1, JSON.stringify(selection.afterEnabled));
	check('the picked track is the active one', selection.afterEnabled[2] === true, JSON.stringify(selection.afterEnabled));
	check('the checkmark follows the selection', selection.afterChecked[2] === true && selection.afterChecked[0] === false, JSON.stringify(selection.afterChecked));
	check('the menu closes after picking', selection.menuClosed === true);
	check('the button shows the active track', (selection.label ?? '').length > 0, String(selection.label));

	console.log('\n== auto-hiding overlay ==');
	const overlayState = await selectPage.evaluate(async () => {
		const stage = document.getElementById('stage') as HTMLElement;
		const top = document.getElementById('stage-top') as HTMLElement;
		const controls = document.getElementById('controls') as HTMLElement;

		// Simulate a mouse move over the stage.
		stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		const shown = !top.classList.contains('hidden-ui');

		// Wait for the auto-hide timeout.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		return {
			shown,
			topHidden: top.classList.contains('hidden-ui'),
			controlsHidden: controls.classList.contains('hidden-ui'),
		};
	});
	console.log('  overlay:', JSON.stringify(overlayState));
	check('the top bar is shown while the pointer moves', overlayState.shown === true);
	check('the top bar hides when the pointer stops', overlayState.topHidden === true);
	check('the controls hide as well', overlayState.controlsHidden === true);

	console.log('\n== quality control ==');
	const qualityPage = await browser.newPage();
	await qualityPage.setViewport({ width: 1400, height: 900 });
	await qualityPage.goto(BASE_URL, { waitUntil: 'networkidle2' });
	const qualityInput = await qualityPage.$('#file-input');
	await qualityInput!.uploadFile(resolve('test/fixtures/large.mkv'));
	await qualityPage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
	await new Promise((r) => setTimeout(r, 800));

	const qualityState = await qualityPage.evaluate(async () => {
		const items = () => document.querySelectorAll<HTMLElement>('#menu-quality .menu-item');
		const options = Array.from(items()).map((item) => item.querySelector('.menu-label')?.textContent ?? '');
		const before = (window as any).__player.effectiveResolution;

		// Open the quality menu on the player and pick the first scaled option.
		(document.getElementById('btn-quality-menu') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 150));
		const target = Array.from(items()).find((item) => item.getAttribute('aria-checked') !== 'true');
		target?.click();
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const after = (window as any).__player.effectiveResolution;
		const canvas = document.getElementById('video-canvas') as HTMLCanvasElement;
		const label = document.getElementById('quality-menu-label')?.textContent;

		// Playback must continue across the change.
		await (window as any).__player.play();
		const timeBefore = (window as any).__player.getMediaTime();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const timeAfter = (window as any).__player.getMediaTime();

		return {
			options,
			label,
			before: { width: before.width, height: before.height, scaled: before.scaled },
			after: { width: after.width, height: after.height, scaled: after.scaled },
			canvasWidth: canvas.width,
			stillPlaying: timeAfter > timeBefore,
		};
	});
	console.log('  quality:', JSON.stringify(qualityState));
	check('quality options are listed', qualityState.options.length > 1, JSON.stringify(qualityState.options));
	check('the source resolution is offered', qualityState.options[0]?.includes('Source') === true, qualityState.options[0]);
	check('selecting a quality changes the render size', qualityState.after.width < qualityState.before.width, JSON.stringify(qualityState));
	check('the canvas follows the quality', qualityState.canvasWidth === qualityState.after.width, `${qualityState.canvasWidth} vs ${qualityState.after.width}`);
	check('the button shows the current quality', (qualityState.label ?? '').length > 0, String(qualityState.label));
	check('playback continues after the change', qualityState.stillPlaying === true);

	console.log('\n== direct remote file (host allows CORS) ==');
	{
		const { createServer } = await import('node:http');
		const fixture = await readFile(resolve('test/fixtures/multi-audio.mkv'));
		const server = createServer((request, response) => {
			response.writeHead(200, {
				'Content-Type': 'video/x-matroska',
				'Content-Length': String(fixture.length),
				'Access-Control-Allow-Origin': '*',
				'Accept-Ranges': 'bytes',
			});
			response.end(fixture);
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
		const port = (server.address() as { port: number }).port;

		const remotePage = await browser.newPage();
		const mediaRequests: string[] = [];
		remotePage.on('request', (request) => mediaRequests.push(request.url()));
		await remotePage.goto(
			`${BASE_URL}?url=${encodeURIComponent(`http://127.0.0.1:${port}/movie.mkv`)}`,
			{ waitUntil: 'networkidle2' },
		);
		await remotePage.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
		await new Promise((r) => setTimeout(r, 1500));

		const remoteState = await remotePage.evaluate(() => {
			const player = (window as any).__player;
			return {
				audioTracks: player.audioChannelStates.length,
				playing: player.isPlaying,
				domCards: document.querySelectorAll('#menu-audio .menu-item').length,
			};
		});
		console.log('  direct remote:', JSON.stringify(remoteState));
		check('the web version plays a CORS-enabled host directly', remoteState.audioTracks === 3, String(remoteState.audioTracks));
		check('the remote file is playing', remoteState.playing === true);
		check('the panel lists the remote tracks', remoteState.domCards === 3, String(remoteState.domCards));
		check(
			'the media is fetched straight from the host',
			mediaRequests.some((url) => url.includes(`127.0.0.1:${port}`)),
			mediaRequests.slice(0, 3).join(' | '),
		);

		await remotePage.close();
		server.close();
	}

	const nonFatal = consoleErrors.filter((text) => !/favicon|Autoplay|net::ERR_FILE/i.test(text));
	check('no console errors', nonFatal.length === 0, nonFatal.slice(0, 3).join(' | '));
} finally {
	await browser.close();
}

console.log(failures === 0 ? '\nAll browser checks passed.\n' : `\n${failures} browser check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
