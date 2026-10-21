/**
 * Packs the `extension/` folder into a zip that can be uploaded to the Chrome
 * Web Store or unpacked directly.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'extension');
const output = join(root, 'multiaudio-player-extension.zip');

if (!existsSync(join(extensionDir, 'dist', 'index.html'))) {
	console.error('extension/dist/index.html is missing — run "npm run build:extension" first.');
	process.exit(1);
}

if (existsSync(output)) rmSync(output);

let result = spawnSync('tar', ['-a', '-c', '-f', output, '-C', extensionDir, '.'], { stdio: 'inherit' });

if (result.status !== 0) {
	result = spawnSync(
		'powershell',
		[
			'-NoProfile',
			'-Command',
			`Compress-Archive -Path '${extensionDir}\\*' -DestinationPath '${output}' -Force`,
		],
		{ stdio: 'inherit' },
	);
}

if (result.status !== 0) {
	console.error('Could not create the zip archive.');
	process.exit(1);
}

console.log(`\nWrote ${output}`);
