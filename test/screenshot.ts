/** Captures screenshots of the app for visual review. */
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT = resolve('test/screenshots');

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-gl=swiftshader', '--window-size=1600,1000'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

await page.screenshot({ path: resolve(OUT, '01-empty.png') });

const input = await page.$('#file-input');
await input!.uploadFile(resolve('test/fixtures/multi-audio.mkv'));
await page.waitForFunction(() => (window as any).__player?.isLoaded === true, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

// Enable the extra audio tracks through the UI so the panel shows the mix state.
await page.evaluate(() => {
	const boxes = document.querySelectorAll<HTMLInputElement>('#audio-track-list input[type="checkbox"]');
	boxes[1]?.click();
	boxes[2]?.click();
});
await new Promise((r) => setTimeout(r, 1200));

// Move the mouse over the stage so the controls are visible.
await page.mouse.move(700, 500);
await new Promise((r) => setTimeout(r, 400));

await page.screenshot({ path: resolve(OUT, '02-playing.png') });

await page.mouse.move(10, 10);
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: resolve(OUT, '03-panel.png'), clip: { x: 1260, y: 0, width: 340, height: 1000 } });

await browser.close();
console.log('screenshots written to', OUT);
