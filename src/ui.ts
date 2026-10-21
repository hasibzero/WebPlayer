import type { MediaPlayer } from './player.ts';
import { describeChannels } from './player.ts';
import { codecName, formatBitrate, formatBytes, formatTime, languageName } from './format.ts';
import type { Chapter } from './mkv.ts';
import type { SubtitleTrack } from './subtitles.ts';

export interface UICallbacks {
	onOpenFile: () => void;
	onOpenUrl: () => void;
	onLoadSubtitles: () => void;
	onSelectSubtitle: (id: string | null) => void;
	onToggleSubtitles: () => void;
	onCloseMedia: () => void;
	onPrevious: () => void;
	onNext: () => void;
}

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing element #${id}`);
	return node as T;
}

interface MenuItem {
	label: string;
	meta?: string;
	checked?: boolean;
	disabled?: boolean;
	onSelect?: () => void;
}

export class PlayerUI {
	private readonly player: MediaPlayer;
	private readonly callbacks: UICallbacks;

	private readonly stage = el<HTMLDivElement>('stage');
	private readonly canvas = el<HTMLCanvasElement>('video-canvas');
	private readonly stageEmpty = el<HTMLDivElement>('stage-empty');
	private readonly stageLoading = el<HTMLDivElement>('stage-loading');
	private readonly loadingText = el<HTMLParagraphElement>('loading-text');
	private readonly progress = el<HTMLDivElement>('progress');
	private readonly progressFill = el<HTMLDivElement>('progress-fill');
	private readonly progressText = el<HTMLSpanElement>('progress-text');
	private readonly stageTop = el<HTMLDivElement>('stage-top');
	private readonly stageTitle = el<HTMLSpanElement>('stage-title');
	private readonly stageBadges = el<HTMLSpanElement>('stage-badges');
	private readonly controls = el<HTMLDivElement>('controls');
	private readonly topFileName = el<HTMLSpanElement>('top-file-name');

	private readonly seekbar = el<HTMLDivElement>('seekbar');
	private readonly seekbarFill = el<HTMLDivElement>('seekbar-fill');
	private readonly seekbarHandle = el<HTMLDivElement>('seekbar-handle');
	private readonly seekbarTooltip = el<HTMLDivElement>('seekbar-tooltip');

	private readonly btnPlay = el<HTMLButtonElement>('btn-play');
	private readonly iconPlay = document.querySelector<SVGElement>('#btn-play .icon-play');
	private readonly iconPause = document.querySelector<SVGElement>('#btn-play .icon-pause');
	private readonly timeCurrent = el<HTMLSpanElement>('time-current');
	private readonly timeDuration = el<HTMLSpanElement>('time-duration');
	private readonly btnMute = el<HTMLButtonElement>('btn-mute');
	private readonly iconVolume = document.querySelector<SVGElement>('#btn-mute .icon-volume');
	private readonly iconMuted = document.querySelector<SVGElement>('#btn-mute .icon-muted');
	private readonly volumeSlider = el<HTMLInputElement>('volume-slider');
	private readonly rateSelect = el<HTMLSelectElement>('rate-select');

	private readonly menuAudio = el<HTMLDivElement>('menu-audio');
	private readonly menuVideo = el<HTMLDivElement>('menu-video');
	private readonly menuSubs = el<HTMLDivElement>('menu-subs');
	private readonly menuQuality = el<HTMLDivElement>('menu-quality');
	private readonly labelAudio = el<HTMLSpanElement>('audio-menu-label');
	private readonly labelVideo = el<HTMLSpanElement>('video-menu-label');
	private readonly labelSubs = el<HTMLSpanElement>('subs-menu-label');
	private readonly labelQuality = el<HTMLSpanElement>('quality-menu-label');

	private readonly panel = el<HTMLDivElement>('panel');
	private readonly audioTrackList = el<HTMLDivElement>('audio-track-list');
	private readonly audioEmpty = el<HTMLParagraphElement>('audio-empty');
	private readonly videoTrackList = el<HTMLDivElement>('video-track-list');
	private readonly subtitleList = el<HTMLDivElement>('subtitle-list');
	private readonly subsEmpty = el<HTMLParagraphElement>('subs-empty');
	private readonly scanStatus = el<HTMLParagraphElement>('scan-status');
	private readonly qualitySelect = el<HTMLSelectElement>('quality-select');
	private readonly qualityNote = el<HTMLParagraphElement>('quality-note');
	private readonly chapterList = el<HTMLDivElement>('chapter-list');
	private readonly chaptersEmpty = el<HTMLParagraphElement>('chapters-empty');
	private readonly chaptersCount = el<HTMLSpanElement>('chapters-count');
	private readonly mediaInfo = el<HTMLDListElement>('media-info');
	private readonly rescanActions = el<HTMLDivElement>('rescan-actions');
	private readonly rescanHint = el<HTMLParagraphElement>('rescan-hint');
	private readonly remoteHint = el<HTMLParagraphElement>('remote-hint');
	private readonly extStatus = el<HTMLDivElement>('ext-status');
	private readonly extStatusText = el<HTMLSpanElement>('ext-status-text');

	private readonly statusText = el<HTMLSpanElement>('status-text');
	private readonly statusRight = el<HTMLSpanElement>('status-right');
	private readonly toastElement = el<HTMLDivElement>('toast');

	private dragging = false;
	private controlsTimeout = 0;
	private toastTimeout = 0;
	private lastRenderedTime = -1;
	private activeChapter = -1;
	private openMenu: HTMLElement | null = null;

	constructor(player: MediaPlayer, callbacks: UICallbacks) {
		this.player = player;
		this.callbacks = callbacks;
		this.bindEvents();
		this.bindPlayerEvents();
	}

	/* ------------------------------------------------------------ wiring */

	private bindEvents(): void {
		el<HTMLButtonElement>('open-file').addEventListener('click', this.callbacks.onOpenFile);
		el<HTMLButtonElement>('empty-open').addEventListener('click', this.callbacks.onOpenFile);
		el<HTMLButtonElement>('open-url').addEventListener('click', this.callbacks.onOpenUrl);
		el<HTMLButtonElement>('btn-load-subs').addEventListener('click', this.callbacks.onLoadSubtitles);
		el<HTMLButtonElement>('btn-subs-off').addEventListener('click', () => this.callbacks.onSelectSubtitle(null));
		el<HTMLButtonElement>('btn-close-media').addEventListener('click', this.callbacks.onCloseMedia);
		el<HTMLButtonElement>('btn-prev').addEventListener('click', this.callbacks.onPrevious);
		el<HTMLButtonElement>('btn-next').addEventListener('click', this.callbacks.onNext);
		el<HTMLButtonElement>('btn-rescan').addEventListener('click', () => {
			this.setLoading(true, 'Re-downloading…');
			void this.player.reloadRemote(true).then(() => this.setLoading(false));
		});

		const togglePanel = el<HTMLButtonElement>('toggle-panel');
		togglePanel.addEventListener('click', () => this.setPanelCollapsed(!this.panel.classList.contains('collapsed')));
		el<HTMLButtonElement>('panel-close').addEventListener('click', () => this.setPanelCollapsed(true));

		this.btnPlay.addEventListener('click', () => this.player.togglePlay());
		this.btnMute.addEventListener('click', () => this.player.toggleMuted());
		el<HTMLButtonElement>('btn-shot').addEventListener('click', () => void this.saveScreenshot());
		el<HTMLButtonElement>('btn-pip').addEventListener('click', () => void this.togglePictureInPicture());
		el<HTMLButtonElement>('btn-fullscreen').addEventListener('click', () => void this.toggleFullscreen());

		this.volumeSlider.addEventListener('input', () => {
			this.player.setVolume(Number(this.volumeSlider.value) / 100);
		});

		this.rateSelect.addEventListener('change', () => {
			void this.player.setPlaybackRate(Number(this.rateSelect.value));
		});

		this.qualitySelect.addEventListener('change', () => {
			const value = this.qualitySelect.value;
			void this.player.setRenderWidth(value === 'source' ? null : Number(value));
		});

		this.bindMenus();
		this.bindSeekbar();

		this.stage.addEventListener('pointermove', () => this.showControls());
		this.stage.addEventListener('pointerleave', () => this.hideControls());
		this.stage.addEventListener('dblclick', () => void this.toggleFullscreen());
		this.stage.addEventListener('click', (event) => {
			if (event.target === this.canvas && this.player.isLoaded) {
				this.player.togglePlay();
			}
		});

		document.addEventListener('click', (event) => {
			if (!this.openMenu) return;
			const target = event.target as Node;
			if (this.openMenu.contains(target)) return;
			if ((target as HTMLElement).closest?.('.menu-wrap')) return;
			this.closeMenu();
		});

		window.addEventListener('keydown', (event) => this.onKeyDown(event));
		window.addEventListener('resize', () => this.fitCanvas());

		if (typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(() => this.fitCanvas()).observe(this.stage);
		}
	}

	/** Wires the on-player track menus. */
	private bindMenus(): void {
		const pairs: Array<[string, HTMLElement]> = [
			['btn-audio-menu', this.menuAudio],
			['btn-video-menu', this.menuVideo],
			['btn-subs-menu', this.menuSubs],
			['btn-quality-menu', this.menuQuality],
		];

		for (const [buttonId, menu] of pairs) {
			const button = el<HTMLButtonElement>(buttonId);
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				this.toggleMenu(menu, button);
			});
		}
	}

	private toggleMenu(menu: HTMLElement, button: HTMLButtonElement): void {
		if (this.openMenu === menu) {
			this.closeMenu();
			return;
		}
		this.closeMenu();
		menu.hidden = false;
		this.openMenu = menu;
		button.setAttribute('aria-expanded', 'true');
		button.classList.add('is-open');
	}

	private closeMenu(): void {
		if (!this.openMenu) return;
		this.openMenu.hidden = true;
		this.openMenu = null;
		for (const button of document.querySelectorAll<HTMLButtonElement>('.tbtn-menu')) {
			button.setAttribute('aria-expanded', 'false');
			button.classList.remove('is-open');
		}
	}

	/** Renders a list of options into one of the menus. */
	private buildMenu(menu: HTMLElement, items: MenuItem[], emptyText?: string): void {
		menu.replaceChildren();

		if (!items.length) {
			const empty = document.createElement('div');
			empty.className = 'menu-empty';
			empty.textContent = emptyText ?? 'Nothing available';
			menu.append(empty);
			return;
		}

		for (const item of items) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'menu-item';
			button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
			if (item.checked !== undefined) {
				button.setAttribute('aria-checked', String(item.checked));
			}
			if (item.disabled) {
				button.disabled = true;
			}

			const check = document.createElement('span');
			check.className = 'menu-check';
			check.textContent = item.checked ? '✓' : '';
			button.append(check);

			const label = document.createElement('span');
			label.className = 'menu-label';
			label.textContent = item.label;
			button.append(label);

			if (item.meta) {
				const meta = document.createElement('span');
				meta.className = 'menu-meta';
				meta.textContent = item.meta;
				button.append(meta);
			}

			if (item.onSelect) {
				button.addEventListener('click', (event) => {
					event.stopPropagation();
					this.closeMenu();
					item.onSelect?.();
				});
			}

			menu.append(button);
		}
	}

	private bindPlayerEvents(): void {
		this.player.on('timeupdate', (time) => this.onTimeUpdate(time as number));
		this.player.on('statechange', () => this.setPlaying(this.player.isPlaying));
		this.player.on('buffering', (value) => this.setLoading(Boolean(value), 'Buffering…'));
		this.player.on('loading', (payload) => {
			const info = payload as { name?: string; downloading?: boolean };
			this.setLoading(true, info.downloading ? 'Downloading…' : info.name ? `Opening ${info.name}…` : 'Opening…');
			this.stageEmpty.hidden = true;
		});
		this.player.on('progress', (payload) => {
			const { loaded, total } = payload as { loaded: number; total: number | null };
			if (total) {
				const percent = Math.min(100, (loaded / total) * 100);
				this.progress.hidden = false;
				this.progressFill.style.width = `${percent}%`;
				this.progressText.textContent = `${formatBytes(loaded)} / ${formatBytes(total)} (${percent.toFixed(0)}%)`;
			}
		});
		this.player.on('subtitles', () => {
			this.renderSubtitleMenu();
		});
		this.player.on('scanprogress', (payload) => {
			const { loaded, total } = payload as { loaded: number; total: number | null };
			if (total) {
				const percent = Math.min(100, (loaded / total) * 100);
				this.scanStatus.hidden = false;
				this.scanStatus.textContent = `Scanning the file for subtitles… ${percent.toFixed(0)}%`;
			}
		});
		this.player.on('ready', () => {
			this.setLoading(false);
			this.stageEmpty.hidden = true;
			this.controls.hidden = false;
			this.stageTop.hidden = false;
			this.stageTop.classList.remove('hidden-ui');
			this.setPlaying(this.player.isPlaying);
			this.renderAudioMenu();
			this.renderVideoMenu();
			this.renderSubtitleMenu();
			this.renderQualityMenu();
			this.setDuration(this.player.duration);
			this.fitCanvas();
			this.updateRescanOptions();
		});
		this.player.on('error', (error) => {
			this.setLoading(false);
			this.toast(error instanceof Error ? error.message : String(error), true);
			this.setStatus('Playback error');
		});
		this.player.on('trackschange', () => {
			this.renderAudioMenu();
			this.renderVideoMenu();
			this.renderSubtitleMenu();
			this.fitCanvas();
			this.updateRescanOptions();
		});
		this.player.on('volumechange', (value) => {
			const volume = value as number;
			this.volumeSlider.value = String(Math.round(volume * 100));
			if (this.iconVolume) this.iconVolume.style.display = volume === 0 ? 'none' : '';
			if (this.iconMuted) this.iconMuted.style.display = volume === 0 ? '' : 'none';
			this.btnMute.classList.toggle('is-active', volume === 0);
		});
		this.player.on('ratechange', (rate) => {
			this.rateSelect.value = String(rate);
		});
		this.player.on('qualitychange', () => {
			this.renderQualityMenu();
			this.fitCanvas();
		});
		this.player.on('ended', () => {
			this.setStatus('End of media');
		});
	}

	/* ------------------------------------------------------------- menus */

	private renderAudioMenu(): void {
		const states = this.player.audioChannelStates;
		const active = states.find((state) => state.enabled);

		this.labelAudio.textContent = active
			? (active.info.name ? languageName(active.info.language) : `Track ${active.info.index + 1}`)
			: 'Audio';

		this.buildMenu(
			this.menuAudio,
			states.map((state) => ({
				label: state.info.name ?? `Track ${state.info.index + 1}`,
				meta: [
					languageName(state.info.language),
					codecName(state.info.codec),
					describeChannels(state.info.channels),
					formatBitrate(state.info.bitrate),
				]
					.filter(Boolean)
					.join(' · '),
				checked: state.enabled,
				disabled: !state.info.decodable,
				onSelect: () => void this.player.soloAudioTrack(state.info.index),
			})),
			'No audio tracks in this file',
		);

		// The inspector shows the same list as dense rows.
		this.audioTrackList.replaceChildren();
		this.audioEmpty.hidden = states.length > 0;

		for (const state of states) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = `track-row${state.enabled ? ' is-active' : ''}`;
			row.disabled = !state.info.decodable;

			const mark = document.createElement('span');
			mark.className = 'track-mark';
			mark.textContent = state.enabled ? '●' : '○';

			const text = document.createElement('span');
			text.className = 'track-text';

			const name = document.createElement('span');
			name.className = 'track-name';
			name.textContent = state.info.name ?? `Track ${state.info.index + 1}`;

			const meta = document.createElement('span');
			meta.className = 'track-meta';
			meta.textContent = [
				codecName(state.info.codec),
				describeChannels(state.info.channels),
				`${(state.info.sampleRate / 1000).toFixed(1)} kHz`,
			]
				.filter(Boolean)
				.join(' · ');

			text.append(name, meta);

			const lang = document.createElement('span');
			lang.className = 'track-lang';
			lang.textContent = languageName(state.info.language);

			row.append(mark, text, lang);
			row.addEventListener('click', () => void this.player.soloAudioTrack(state.info.index));
			this.audioTrackList.append(row);
		}
	}

	private renderVideoMenu(): void {
		const tracks = this.player.videoTrackInfos;
		const activeIndex = this.player.activeVideoIndexValue;
		const active = tracks.find((track) => track.index === activeIndex);

		this.labelVideo.textContent = active ? `${active.displayWidth}×${active.displayHeight}` : 'Video';

		this.buildMenu(
			this.menuVideo,
			tracks.map((track) => ({
				label: `Track ${track.index + 1}`,
				meta: [codecName(track.codec), `${track.displayWidth}×${track.displayHeight}`, formatBitrate(track.bitrate)]
					.filter(Boolean)
					.join(' · '),
				checked: track.index === activeIndex,
				disabled: !track.decodable,
				onSelect: () => void this.player.selectVideoTrack(track.index),
			})),
			'No video tracks in this file',
		);

		this.videoTrackList.replaceChildren();
		for (const track of tracks) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = `track-row${track.index === activeIndex ? ' is-active' : ''}`;
			row.disabled = !track.decodable;

			const mark = document.createElement('span');
			mark.className = 'track-mark';
			mark.textContent = track.index === activeIndex ? '●' : '○';

			const text = document.createElement('span');
			text.className = 'track-text';

			const name = document.createElement('span');
			name.className = 'track-name';
			name.textContent = `Track ${track.index + 1}`;

			const meta = document.createElement('span');
			meta.className = 'track-meta';
			meta.textContent = [codecName(track.codec), `${track.displayWidth}×${track.displayHeight}`]
				.filter(Boolean)
				.join(' · ');

			text.append(name, meta);

			row.append(mark, text);
			row.addEventListener('click', () => void this.player.selectVideoTrack(track.index));
			this.videoTrackList.append(row);
		}
	}

	private renderSubtitleMenu(): void {
		const tracks = this.subtitleTracks;
		const active = tracks.find((track) => track.id === this.activeSubtitleId);

		this.labelSubs.textContent = active ? (active.name || languageName(active.language)) : 'Off';

		const items: MenuItem[] = [
			{
				label: 'Off',
				checked: !active,
				onSelect: () => this.callbacks.onSelectSubtitle(null),
			},
			...tracks.map((track) => ({
				label: track.name,
				meta: [languageName(track.language), `${track.cues.length} cues`].filter(Boolean).join(' · '),
				checked: track.id === this.activeSubtitleId,
				onSelect: () => this.callbacks.onSelectSubtitle(track.id),
			})),
			{
				label: 'Load subtitle file…',
				onSelect: () => this.callbacks.onLoadSubtitles(),
			},
		];

		this.buildMenu(this.menuSubs, items, 'No subtitles in this file');

		// The inspector list.
		this.subtitleList.replaceChildren();
		this.subsEmpty.hidden = tracks.length > 0;

		for (const track of tracks) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = `track-row${track.id === this.activeSubtitleId ? ' is-active' : ''}`;

			const mark = document.createElement('span');
			mark.className = 'track-mark';
			mark.textContent = track.id === this.activeSubtitleId ? '●' : '○';

			const text = document.createElement('span');
			text.className = 'track-text';

			const name = document.createElement('span');
			name.className = 'track-name';
			name.textContent = track.name;

			const meta = document.createElement('span');
			meta.className = 'track-meta';
			meta.textContent = `${track.cues.length} cues`;

			text.append(name, meta);

			const lang = document.createElement('span');
			lang.className = 'track-lang';
			lang.textContent = languageName(track.language);

			row.append(mark, text, lang);
			row.addEventListener('click', () => this.callbacks.onSelectSubtitle(track.id));
			this.subtitleList.append(row);
		}
	}

	private renderQualityMenu(): void {
		const resolution = this.player.effectiveResolution;
		this.labelQuality.textContent = resolution.sourceWidth
			? resolution.scaled
				? `${resolution.width}×${resolution.height}`
				: `${resolution.sourceWidth}p`
			: 'Quality';

		const steps = [2160, 1440, 1080, 720, 480, 360, 240];
		const items: MenuItem[] = [
			{
				label: `Source (${resolution.sourceWidth}×${resolution.sourceHeight})`,
				checked: !resolution.scaled,
				onSelect: () => void this.player.setRenderWidth(null),
			},
		];

		for (const height of steps) {
			const width = Math.round((height * resolution.sourceWidth) / resolution.sourceHeight);
			if (width >= resolution.sourceWidth) continue;
			items.push({
				label: `${height}p (${width} wide)`,
				checked: resolution.width === width,
				onSelect: () => void this.player.setRenderWidth(width),
			});
		}

		this.buildMenu(this.menuQuality, items, 'No video loaded');

		// The inspector dropdown mirrors the menu.
		this.qualitySelect.replaceChildren();
		this.qualitySelect.disabled = !resolution.sourceWidth;
		for (const item of items) {
			const option = document.createElement('option');
			option.value = item.checked ? 'source' : (item.label.match(/\((\d+) wide\)/)?.[1] ?? 'source');
			option.textContent = item.label;
			option.selected = item.checked === true;
			this.qualitySelect.append(option);
		}
		this.qualityNote.hidden = !resolution.scaled;
		this.qualityNote.textContent = resolution.scaled
			? `Playing at ${resolution.width}×${resolution.height} instead of ${resolution.sourceWidth}×${resolution.sourceHeight}.`
			: '';
	}

	/* ------------------------------------------------------------- state */

	private subtitleTracks: SubtitleTrack[] = [];
	private activeSubtitleId: string | null = null;

	/** Registers the subtitle tracks that are available for selection. */
	setSubtitleTracks(tracks: SubtitleTrack[], activeId: string | null): void {
		this.subtitleTracks = tracks;
		this.activeSubtitleId = activeId;
		this.renderSubtitleMenu();
	}

	/* ------------------------------------------------------------ seek bar */

	private bindSeekbar(): void {
		const timeFromEvent = (event: PointerEvent): number => {
			const rect = this.seekbar.getBoundingClientRect();
			const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
			const start = this.player.startTime;
			const end = this.player.duration || start + 1;
			return start + ratio * (end - start);
		};

		this.seekbar.addEventListener('pointerdown', (event) => {
			if (!this.player.isLoaded) return;
			this.dragging = true;
			this.seekbar.classList.add('dragging');
			this.seekbar.setPointerCapture(event.pointerId);
			this.showSeekPreview(timeFromEvent(event), event);
		});

		this.seekbar.addEventListener('pointermove', (event) => {
			if (!this.player.isLoaded) return;
			this.showSeekPreview(timeFromEvent(event), event);
		});

		const finish = (event: PointerEvent) => {
			if (!this.dragging) return;
			this.dragging = false;
			this.seekbar.classList.remove('dragging');
			this.seekbar.releasePointerCapture(event.pointerId);
			void this.player.seek(timeFromEvent(event));
			this.showControls();
		};

		this.seekbar.addEventListener('pointerup', finish);
		this.seekbar.addEventListener('pointercancel', finish);
		this.seekbar.addEventListener('pointerleave', () => {
			if (!this.dragging) this.seekbarTooltip.hidden = true;
		});
	}

	private showSeekPreview(time: number, event: PointerEvent): void {
		const start = this.player.startTime;
		const end = this.player.duration || start + 1;
		const ratio = end > start ? (time - start) / (end - start) : 0;
		const percent = Math.max(0, Math.min(1, ratio)) * 100;
		this.seekbarFill.style.width = `${percent}%`;
		this.seekbarHandle.style.left = `${percent}%`;
		this.seekbarTooltip.textContent = formatTime(time);
		this.seekbarTooltip.hidden = false;
		const rect = this.seekbar.getBoundingClientRect();
		const x = ((event.clientX - rect.left) / rect.width) * rect.width;
		this.seekbarTooltip.style.left = `${Math.max(24, Math.min(rect.width - 24, x))}px`;
	}

	private onTimeUpdate(time: number): void {
		if (this.dragging) return;
		const start = this.player.startTime;
		const end = this.player.duration || start + 1;
		const ratio = end > start ? (time - start) / (end - start) : 0;
		const percent = Math.max(0, Math.min(1, ratio)) * 100;
		this.seekbarFill.style.width = `${percent}%`;
		this.seekbarHandle.style.left = `${percent}%`;
		this.timeCurrent.textContent = formatTime(time);
		this.seekbar.setAttribute('aria-valuenow', String(Math.round(percent)));
		this.updateChapterHighlight(time);

		if (Math.abs(time - this.lastRenderedTime) > 0.25) {
			this.lastRenderedTime = time;
			this.statusRight.textContent = `${formatTime(time)} / ${formatTime(end)}`;
		}
	}

	private updateChapterHighlight(time: number): void {
		if (!this.chapters.length) return;
		let index = -1;
		for (let i = 0; i < this.chapters.length; i++) {
			if (this.chapters[i].start <= time + 0.01) index = i;
			else break;
		}
		if (index === this.activeChapter) return;
		this.activeChapter = index;
		const items = this.chapterList.querySelectorAll<HTMLElement>('.chapter-row');
		items.forEach((item, i) => item.classList.toggle('is-active', i === index));
	}

	/* ------------------------------------------------------------- setters */

	setDuration(duration: number): void {
		this.timeDuration.textContent = formatTime(duration);
	}

	setPlaying(playing: boolean): void {
		if (this.iconPlay) this.iconPlay.style.display = playing ? 'none' : '';
		if (this.iconPause) this.iconPause.style.display = playing ? '' : 'none';
		this.btnPlay.title = playing ? 'Pause (Space)' : 'Play (Space)';
	}

	setLoading(loading: boolean, text = 'Loading…'): void {
		this.stageLoading.hidden = !loading;
		this.loadingText.textContent = text;
		if (!loading) {
			this.progress.hidden = true;
			this.progressFill.style.width = '0%';
			this.progressText.textContent = '';
		}
	}

	setEmptyState(empty: boolean): void {
		this.stageEmpty.hidden = !empty;
		this.topFileName.textContent = empty ? 'No media loaded' : this.topFileName.textContent;
		if (empty) {
			this.controls.hidden = true;
			this.stageTop.hidden = true;
		}
	}

	setMediaTitle(name: string, subtitle: string): void {
		this.stageTitle.textContent = name;
		this.topFileName.textContent = name;
		this.topFileName.title = subtitle;
	}

	setBadges(badges: string[]): void {
		this.stageBadges.replaceChildren();
		for (const badge of badges) {
			const node = document.createElement('span');
			node.className = 'badge';
			node.textContent = badge;
			this.stageBadges.append(node);
		}
	}

	setStatus(text: string): void {
		this.statusText.textContent = text;
	}

	toast(
		message: string,
		isError = false,
		actions?: Array<{ label: string; href?: string; onClick?: () => void }>,
	): void {
		this.toastElement.textContent = '';
		this.toastElement.classList.toggle('is-error', isError);

		const text = document.createElement('div');
		text.textContent = message;
		this.toastElement.append(text);

		for (const action of actions ?? []) {
			const button = document.createElement('button');
			button.className = 'toast-action';
			button.textContent = action.label;
			if (action.href) {
				button.addEventListener('click', () => {
					window.open(action.href, '_blank', 'noopener');
				});
			} else {
				button.addEventListener('click', () => {
					action.onClick?.();
					this.toastElement.hidden = true;
				});
			}
			this.toastElement.append(button);
		}

		this.toastElement.hidden = false;
		clearTimeout(this.toastTimeout);
		this.toastTimeout = window.setTimeout(() => {
			this.toastElement.hidden = true;
		}, isError ? 20000 : 2600);
	}

	setPanelCollapsed(collapsed: boolean): void {
		this.panel.classList.toggle('collapsed', collapsed);
		el<HTMLButtonElement>('toggle-panel').setAttribute('aria-pressed', String(collapsed));
	}

	/**
	 * Shows the hint about third-party links that need the extension.
	 */
	setRemoteHint(visible: boolean): void {
		this.remoteHint.hidden = !visible;
	}

	/** Shows whether the browser extension was detected on this page. */
	setExtensionStatus(present: boolean): void {
		this.extStatus.hidden = false;
		this.extStatus.classList.toggle('is-ok', present);
		this.extStatusText.textContent = present
			? 'Browser extension detected — remote links work'
			: 'Browser extension not detected — remote links need it';
	}

	/** Renders the chapters list. */
	renderChapters(chapters: Chapter[]): void {
		this.chapters = chapters;
		this.activeChapter = -1;
		this.chapterList.replaceChildren();
		this.chaptersEmpty.hidden = chapters.length > 0;
		this.chaptersCount.textContent = chapters.length ? `${chapters.length} chapters` : '';

		for (const chapter of chapters) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'chapter-row';

			const time = document.createElement('span');
			time.className = 'chapter-time';
			time.textContent = formatTime(chapter.start);

			const title = document.createElement('span');
			title.className = 'chapter-title';
			title.textContent = chapter.title;

			row.append(time, title);
			row.addEventListener('click', () => {
				void this.player.seek(chapter.start);
			});
			this.chapterList.append(row);
		}
	}

	setMediaInfo(entries: Array<[string, string]>): void {
		this.mediaInfo.replaceChildren();
		for (const [key, value] of entries) {
			const dt = document.createElement('dt');
			dt.textContent = key;
			const dd = document.createElement('dd');
			dd.textContent = value;
			dd.title = value;
			this.mediaInfo.append(dt, dd);
		}
	}

	/**
	 * Remote files can be delivered in a way that hides extra tracks, so offer
	 * a way to fetch the file completely and scan it again.
	 */
	private updateRescanOptions(): void {
		const isRemote = this.player.remoteSource !== null;
		this.rescanActions.hidden = !isRemote;
		this.rescanHint.hidden = !(isRemote && this.player.audioChannelStates.length <= 1);
	}

	private chapters: Chapter[] = [];

	/* ---------------------------------------------------------- behaviour */

	private showControls(): void {
		this.controls.classList.remove('hidden-ui');
		this.stageTop.classList.remove('hidden-ui');
		clearTimeout(this.controlsTimeout);
		this.controlsTimeout = window.setTimeout(() => {
			if (this.player.isPlaying && !this.dragging) {
				this.controls.classList.add('hidden-ui');
				this.stageTop.classList.add('hidden-ui');
			}
		}, 2600);
	}

	private hideControls(): void {
		if (this.player.isPlaying) {
			this.controls.classList.add('hidden-ui');
			this.stageTop.classList.add('hidden-ui');
		}
	}

	/** Scales the canvas so the video keeps its aspect ratio inside the stage. */
	private fitCanvas(): void {
		const width = this.canvas.width;
		const height = this.canvas.height;
		if (!width || !height) return;

		const rect = this.stage.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		const scale = Math.min(rect.width / width, rect.height / height);
		this.canvas.style.width = `${Math.max(1, Math.floor(width * scale))}px`;
		this.canvas.style.height = `${Math.max(1, Math.floor(height * scale))}px`;
	}

	private async toggleFullscreen(): Promise<void> {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await this.stage.requestFullscreen();
			}
		} catch (error) {
			this.toast('Fullscreen is not available here.', true);
			console.warn(error);
		}
	}

	private async togglePictureInPicture(): Promise<void> {
		const anyCanvas = this.canvas as HTMLCanvasElement & {
			requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
		};
		if (document.pictureInPictureElement) {
			await document.exitPictureInPicture();
			return;
		}
		if (!anyCanvas.requestPictureInPicture) {
			this.toast('Picture-in-picture is not supported in this browser.', true);
			return;
		}
		try {
			await anyCanvas.requestPictureInPicture();
		} catch (error) {
			this.toast('Could not enter picture-in-picture mode.', true);
			console.warn(error);
		}
	}

	private async saveScreenshot(): Promise<void> {
		if (!this.player.isLoaded) return;
		try {
			const canvas = this.canvas;
			const copy = document.createElement('canvas');
			copy.width = canvas.width;
			copy.height = canvas.height;
			const context = copy.getContext('2d');
			if (!context) return;
			context.drawImage(canvas, 0, 0);
			const blob = await new Promise<Blob | null>((resolve) =>
				copy.toBlob((value) => resolve(value), 'image/png'),
			);
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `screenshot-${Date.now()}.png`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 4000);
		} catch (error) {
			this.toast('Could not save the screenshot.', true);
			console.warn(error);
		}
	}

	private onKeyDown(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
		if (event.key === 'Escape' && this.openMenu) {
			this.closeMenu();
			return;
		}
		if (!this.player.isLoaded) return;

		const time = this.player.getMediaTime();
		const duration = this.player.duration;
		let handled = true;

		switch (event.code) {
			case 'Space':
			case 'KeyK':
				this.player.togglePlay();
				break;
			case 'ArrowLeft':
				void this.player.seek(time - 5);
				break;
			case 'ArrowRight':
				void this.player.seek(time + 5);
				break;
			case 'ArrowUp':
				this.player.setVolume(Math.min(1, this.player.currentVolume + 0.05));
				break;
			case 'ArrowDown':
				this.player.setVolume(Math.max(0, this.player.currentVolume - 0.05));
				break;
			case 'KeyM':
				this.player.toggleMuted();
				break;
			case 'KeyF':
				void this.toggleFullscreen();
				break;
			case 'KeyP':
				void this.togglePictureInPicture();
				break;
			case 'KeyS':
				void this.saveScreenshot();
				break;
			case 'KeyC':
				this.callbacks.onToggleSubtitles();
				break;
			case 'BracketLeft':
				void this.player.setPlaybackRate(Math.max(0.1, this.player.playbackRate - 0.25));
				break;
			case 'BracketRight':
				void this.player.setPlaybackRate(Math.min(4, this.player.playbackRate + 0.25));
				break;
			case 'Home':
				void this.player.seek(this.player.startTime);
				break;
			case 'End':
				void this.player.seek(duration);
				break;
			case 'Digit0':
			case 'Digit1':
			case 'Digit2':
			case 'Digit3':
			case 'Digit4':
			case 'Digit5':
			case 'Digit6':
			case 'Digit7':
			case 'Digit8':
			case 'Digit9': {
				const percent = Number(event.code.slice(5)) / 10;
				void this.player.seek(this.player.startTime + percent * (duration - this.player.startTime));
				break;
			}
			default:
				handled = false;
		}

		if (handled) {
			event.preventDefault();
			this.showControls();
		}
	}
}
