/**
 * Renders the extension icons (16/32/48/128 px) from an inline SVG using the
 * locally installed Chrome. Run with: node scripts/make-icons.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const sizes = [16, 32, 48, 128];

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
	<defs>
		<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#4f8cff"/>
			<stop offset="0.55" stop-color="#9d6bff"/>
			<stop offset="1" stop-color="#35d0ba"/>
		</linearGradient>
	</defs>
	<rect x="2" y="2" width="124" height="124" rx="28" fill="url(#g)"/>
	<path d="M48 38 L92 64 L48 90 Z" fill="#0b0d12" fill-opacity="0.88"/>
	<g fill="#0b0d12" fill-opacity="0.55">
		<rect x="24" y="86" width="7" height="16" rx="3.5"/>
		<rect x="36" y="94" width="7" height="20" rx="3.5"/>
		<rect x="48" y="82" width="7" height="24" rx="3.5"/>
		<rect x="60" y="92" width="7" height="18" rx="3.5"/>
	</g>
</svg>`;

await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	args: ['--no-sandbox', '--use-gl=swiftshader'],
});

try {
	const page = await browser.newPage();
	for (const size of sizes) {
		await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
		await page.setContent(
			`<html><body style="margin:0;background:transparent">${svg.replace(
				'width="128" height="128"',
				`width="${size}" height="${size}"`,
			)}</body></html>`,
		);
		const buffer = await page.screenshot({ omitBackground: true, type: 'png' });
		await writeFile(join(outDir, `icon${size}.png`), buffer);
		console.log(`wrote icon${size}.png`);
	}
} finally {
	await browser.close();
}
