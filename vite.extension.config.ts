import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Builds the player page that ships inside the browser extension.
 * The output lands in `extension/dist`, which is loaded unpacked from the
 * `extension/` folder.
 */
export default defineConfig({
	base: './',
	build: {
		outDir: 'extension/dist',
		emptyOutDir: true,
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			input: {
				player: `${root}index.html`,
			},
		},
	},
});
