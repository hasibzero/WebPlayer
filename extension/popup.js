/** Popup logic: open a URL in the bundled player, or the player itself for local files. */

const urlInput = document.getElementById('url');
const openButton = document.getElementById('open');
const pickButton = document.getElementById('pick');

function playerUrl(params) {
	const search = params.toString();
	return `${chrome.runtime.getURL('dist/index.html')}${search ? `?${search}` : ''}`;
}

openButton.addEventListener('click', () => {
	const url = urlInput.value.trim();
	if (!url) {
		urlInput.focus();
		return;
	}
	const params = new URLSearchParams({ url });
	chrome.tabs.create({ url: playerUrl(params) });
	window.close();
});

pickButton.addEventListener('click', () => {
	chrome.tabs.create({ url: playerUrl(new URLSearchParams()) });
	window.close();
});

urlInput.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') openButton.click();
});
