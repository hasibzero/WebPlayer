import type { AudioChannelState, MediaPlayer, VideoTrackInfo } from './player.ts';
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
	private readonly stageTitle = el<HTMLDivElement>('stage-title');
	private readonly stageBadges = el<HTMLDivElement>('stage-badges');
	private readonly controls = el<HTMLDivElement>('controls');

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

	private readonly btnSubs = el<HTMLButtonElement>('btn-subs');
	private readonly btnShot = el<HTMLButtonElement>('btn-shot');
	private readonly btnPip = el<HTMLButtonElement>('btn-pip');
	private readonly btnFullscreen = el<HTMLButtonElement>('btn-fullscreen');

	private readonly nowPlaying = el<HTMLDivElement>('now-playing');
	private readonly npTitle = el<HTMLDivElement>('np-title');
	private readonly npSub = el<HTMLDivElement>('np-sub');
	private readonly panel = el<HTMLDivElement>('panel');

	private readonly audioTrackList = el<HTMLDivElement>('audio-track-list');
	private readonly audioEmpty = el<HTMLParagraphElement>('audio-empty');
	private readonly videoTrackList = el<HTMLDivElement>('video-track-list');
	private readonly subtitleList = el<HTMLDivElement>('subtitle-list');
	private readonly subsEmpty = el<HTMLParagraphElement>('subs-empty');
	private readonly scanStatus = el<HTMLParagraphElement>('scan-status');
	private readonly chapterList = el<HTMLDivElement>('chapter-list');
	private readonly chaptersEmpty = el<HTMLParagraphElement>('chapters-empty');
	private readonly qualitySelect = el<HTMLSelectElement>('quality-select');
	private readonly qualityNote = el<HTMLParagraphElement>('quality-note');
	private readonly mediaInfo = el<HTMLDListElement>('media-info');
	private readonly rescanActions = el<HTMLDivElement>('rescan-actions');
	private readonly rescanHint = el<HTMLParagraphElement>('rescan-hint');
	private readonly remoteHint = el<HTMLParagraphElement>('remote-hint');

	private readonly statusText = el<HTMLSpanElement>('status-text');
	private readonly statusRight = el<HTMLSpanElement>('status-right');
	private readonly toastElement = el<HTMLDivElement>('toast');

	private dragging = false;
	private controlsTimeout = 0;
	private toastTimeout = 0;
	private lastRenderedTime = -1;
	private hasMedia = false;
	private chapters: Chapter[] = [];
	private activeChapter = -1;

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
		el<HTMLButtonElement>('btn-rescan').addEventListener('click', () => {
			this.setLoading(true, 'Re-downloading…');
			void this.player.reloadRemote(true).then(() => this.setLoading(false));
		});
		el<HTMLButtonElement>('btn-close-media').addEventListener('click', this.callbacks.onCloseMedia);
		el<HTMLButtonElement>('btn-prev').addEventListener('click', this.callbacks.onPrevious);
		el<HTMLButtonElement>('btn-next').addEventListener('click', this.callbacks.onNext);

		const togglePanel = el<HTMLButtonElement>('toggle-panel');
		togglePanel.addEventListener('click', () => this.setPanelCollapsed(!this.panel.classList.contains('collapsed')));
		el<HTMLButtonElement>('panel-close').addEventListener('click', () => this.setPanelCollapsed(true));

		this.btnPlay.addEventListener('click', () => this.player.togglePlay());
		this.btnMute.addEventListener('click', () => this.player.toggleMuted());
		this.btnFullscreen.addEventListener('click', () => void this.toggleFullscreen());
		this.btnShot.addEventListener('click', () => void this.saveScreenshot());
		this.btnPip.addEventListener('click', () => void this.togglePictureInPicture());
		this.btnSubs.addEventListener('click', () => this.callbacks.onToggleSubtitles());

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

		this.bindSeekbar();

		// Auto-hiding controls.
		this.stage.addEventListener('pointermove', () => this.showControls());
		this.stage.addEventListener('pointerleave', () => this.hideControls());
		this.stage.addEventListener('dblclick', () => void this.toggleFullscreen());
		this.stage.addEventListener('click', (event) => {
			if (event.target === this.canvas && this.player.isLoaded) {
				this.player.togglePlay();
			}
		});

		window.addEventListener('keydown', (event) => this.onKeyDown(event));
		window.addEventListener('resize', () => this.fitCanvas());

		if (typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(() => this.fitCanvas()).observe(this.stage);
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

	private bindPlayerEvents(): void {
		this.player.on('timeupdate', (time) => this.onTimeUpdate(time as number));
		this.player.on('statechange', () => this.setPlaying(this.player.isPlaying));
		this.player.on('scanprogress', (payload) => {
			const { loaded, total } = payload as { loaded: number; total: number | null };
			if (total) {
				const percent = Math.min(100, (loaded / total) * 100);
				this.scanStatus.hidden = false;
				this.scanStatus.textContent = `Scanning the file for subtitles… ${percent.toFixed(0)}%`;
			}
		});

		this.player.on('subtitles', () => {
			this.scanStatus.hidden = true;
		});

		this.player.on('buffering', (value) => this.setLoading(Boolean(value), 'Buffering…'));
		this.player.on('loading', (payload) => {
			const info = payload as { name?: string; downloading?: boolean };
			this.setLoading(true, info.downloading ? 'Downloading…' : info.name ? `Opening ${info.name}…` : 'Opening…');
			this.stageEmpty.hidden = true;
		});
		this.player.on('progress', (payload) => {
			const { loaded, total } = payload as { loaded: number; total: number | null };
			this.progress.hidden = false;
			const percent = total ? Math.min(100, (loaded / total) * 100) : 0;
			this.progressFill.style.width = `${percent}%`;
			this.progressText.textContent = total
				? `${formatBytes(loaded)} / ${formatBytes(total)} (${percent.toFixed(0)}%)`
				: formatBytes(loaded);
		});
		this.player.on('ready', () => {
			this.setLoading(false);
			this.hasMedia = true;
			this.stageEmpty.hidden = true;
			this.controls.hidden = false;
			this.stageTop.hidden = false;
			this.stageTop.classList.remove('hidden-ui');
			this.nowPlaying.hidden = false;
			this.setPlaying(this.player.isPlaying);
			this.renderAudioTracks(this.player.audioChannelStates);
			this.renderVideoTracks(this.player.videoTrackInfos, this.player.activeVideoIndexValue);
			this.setDuration(this.player.duration);
			this.fitCanvas();
			this.updateRescanOptions();
			this.renderQualityOptions();
		});
		this.player.on('error', (error) => {
			this.setLoading(false);
			if (!this.hasMedia) this.stageEmpty.hidden = false;
			this.toast(error instanceof Error ? error.message : String(error), true);
			this.setStatus('Playback error');
		});
		this.player.on('trackschange', () => {
			this.renderAudioTracks(this.player.audioChannelStates);
			this.renderVideoTracks(this.player.videoTrackInfos, this.player.activeVideoIndexValue);
			this.fitCanvas();
			this.updateRescanOptions();
			this.renderQualityOptions();
		});
		this.player.on('volumechange', (value) => {
			const volume = value as number;
			this.volumeSlider.value = String(Math.round(volume * 100));
			if (this.iconVolume) this.iconVolume.style.display = volume === 0 ? 'none' : '';
			if (this.iconMuted) this.iconMuted.style.display = volume === 0 ? '' : 'none';
			this.btnMute.classList.toggle('active', volume === 0);
		});
		this.player.on('ratechange', (rate) => {
			this.rateSelect.value = String(rate);
		});
		this.player.on('qualitychange', () => {
			this.renderQualityOptions();
			this.fitCanvas();
		});
		this.player.on('ended', () => {
			this.setStatus('End of media');
		});
	}

	/* ---------------------------------------------------------- seek bar */

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
			const time = timeFromEvent(event);
			if (this.dragging) {
				this.showSeekPreview(time, event);
			} else {
				this.showSeekPreview(time, event);
			}
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

	/* ------------------------------------------------------------- state */

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
		const items = this.chapterList.querySelectorAll<HTMLElement>('.chapter-item');
		items.forEach((item, i) => item.classList.toggle('active', i === index));
	}

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
		if (empty) {
			this.controls.hidden = true;
			this.stageTop.hidden = true;
			this.nowPlaying.hidden = true;
		}
	}

	setMediaTitle(name: string, subtitle: string): void {
		this.stageTitle.textContent = name;
		this.npTitle.textContent = name;
		this.npSub.textContent = subtitle;
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
		this.toastElement.classList.toggle('error', isError);

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

	/* ------------------------------------------------------------ lists */

	renderAudioTracks(states: AudioChannelState[]): void {
		this.audioTrackList.replaceChildren();
		this.audioEmpty.hidden = states.length > 0;

		for (const state of states) {
			const info = state.info;
			const card = document.createElement('div');
			card.className = `track-card${state.enabled ? ' selected' : ''}`;

			const head = document.createElement('div');
			head.className = 'track-head';

			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'audio-track';
			radio.checked = state.enabled;
			radio.addEventListener('change', () => {
				if (radio.checked) void this.player.soloAudioTrack(info.index);
			});

			const meta = document.createElement('div');
			meta.className = 'track-meta';

			const name = document.createElement('div');
			name.className = 'track-name';
			name.append(document.createTextNode(`${info.name ?? `Track ${info.index + 1}`}`));

			const langTag = document.createElement('span');
			langTag.className = 'tag';
			langTag.textContent = languageName(info.language);
			name.append(langTag);

			if (info.isDefault) {
				const tag = document.createElement('span');
				tag.className = 'tag default';
				tag.textContent = 'default';
				name.append(tag);
			}
			if (!info.decodable) {
				const tag = document.createElement('span');
				tag.className = 'tag';
				tag.textContent = 'unsupported codec';
				name.append(tag);
			}

			const sub = document.createElement('div');
			sub.className = 'track-sub';
			sub.textContent = [
				codecName(info.codec),
				describeChannels(info.channels),
				`${(info.sampleRate / 1000).toFixed(1)} kHz`,
				formatBitrate(info.bitrate),
			]
				.filter(Boolean)
				.join(' · ');

			meta.append(name, sub);
			head.append(radio, meta);
			card.append(head);

			// Only the active track has a volume control.
			if (state.enabled) {
				const volume = document.createElement('div');
				volume.className = 'track-volume';

				const slider = document.createElement('input');
				slider.type = 'range';
				slider.className = 'slider';
				slider.min = '0';
				slider.max = '100';
				slider.value = String(Math.round(state.volume * 100));
				slider.addEventListener('input', () => {
					this.player.setAudioTrackVolume(info.index, Number(slider.value) / 100);
					value.textContent = `${slider.value}%`;
				});

				const value = document.createElement('span');
				value.textContent = `${Math.round(state.volume * 100)}%`;

				volume.append(slider, value);
				card.append(volume);
			}

			this.audioTrackList.append(card);
		}
	}

	renderVideoTracks(tracks: VideoTrackInfo[], activeIndex: number): void {
		this.videoTrackList.replaceChildren();

		for (const track of tracks) {
			const card = document.createElement('div');
			card.className = `track-card${track.index === activeIndex ? ' selected' : ''}`;

			const head = document.createElement('div');
			head.className = 'track-head';

			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'video-track';
			radio.checked = track.index === activeIndex;
			radio.addEventListener('change', () => {
				void this.player.selectVideoTrack(track.index);
			});

			const meta = document.createElement('div');
			meta.className = 'track-meta';

			const name = document.createElement('div');
			name.className = 'track-name';
			name.append(document.createTextNode(`Track ${track.index + 1}`));
			if (track.isDefault) {
				const tag = document.createElement('span');
				tag.className = 'tag default';
				tag.textContent = 'default';
				name.append(tag);
			}
			if (!track.decodable) {
				const tag = document.createElement('span');
				tag.className = 'tag';
				tag.textContent = 'unsupported codec';
				name.append(tag);
			}

			const sub = document.createElement('div');
			sub.className = 'track-sub';
			sub.textContent = [
				codecName(track.codec),
				`${track.displayWidth}×${track.displayHeight}`,
				formatBitrate(track.bitrate),
			]
				.filter(Boolean)
				.join(' · ');

			meta.append(name, sub);
			head.append(radio, meta);
			card.append(head);
			this.videoTrackList.append(card);
		}
	}

	renderSubtitles(tracks: SubtitleTrack[], activeId: string | null): void {
		this.subtitleList.replaceChildren();
		this.subsEmpty.hidden = tracks.length > 0;
		this.btnSubs.classList.toggle('active', activeId !== null);

		for (const track of tracks) {
			const card = document.createElement('div');
			card.className = `track-card${track.id === activeId ? ' selected' : ''}`;

			const head = document.createElement('div');
			head.className = 'track-head';

			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'subtitle-track';
			radio.checked = track.id === activeId;
			radio.addEventListener('change', () => this.callbacks.onSelectSubtitle(track.id));

			const meta = document.createElement('div');
			meta.className = 'track-meta';

			const name = document.createElement('div');
			name.className = 'track-name';
			name.append(document.createTextNode(track.name));
			const langTag = document.createElement('span');
			langTag.className = 'tag';
			langTag.textContent = languageName(track.language);
			name.append(langTag);
			if (track.source === 'embedded') {
				const tag = document.createElement('span');
				tag.className = 'tag';
				tag.textContent = 'in file';
				name.append(tag);
			}

			const sub = document.createElement('div');
			sub.className = 'track-sub';
			sub.textContent = `${track.cues.length} cues`;

			meta.append(name, sub);
			head.append(radio, meta);
			card.append(head);
			this.subtitleList.append(card);
		}
	}

	renderChapters(chapters: Chapter[]): void {
		this.chapters = chapters;
		this.activeChapter = -1;
		this.chapterList.replaceChildren();
		this.chaptersEmpty.hidden = chapters.length > 0;

		for (const chapter of chapters) {
			const item = document.createElement('div');
			item.className = 'chapter-item';

			const time = document.createElement('span');
			time.className = 'ch-time';
			time.textContent = formatTime(chapter.start);

			const title = document.createElement('span');
			title.className = 'ch-title';
			title.textContent = chapter.title;

			item.append(time, title);
			item.addEventListener('click', () => {
				void this.player.seek(chapter.start);
			});
			this.chapterList.append(item);
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
	 * Shows the hint about third-party links that need the extension.
	 */
	setRemoteHint(visible: boolean): void {
		this.remoteHint.hidden = !visible;
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

	/**
	 * Fills the quality dropdown with the source resolution plus the smaller
	 * standard resolutions, so the picture can be scaled down on slow machines.
	 */
	private renderQualityOptions(): void {
		const resolution = this.player.effectiveResolution;
		const current = this.qualitySelect.value;

		this.qualitySelect.replaceChildren();

		if (!resolution.sourceWidth) {
			this.qualitySelect.disabled = true;
			this.qualityNote.hidden = true;
			return;
		}

		this.qualitySelect.disabled = false;

		const steps = [2160, 1440, 1080, 720, 480, 360, 240];
		const options: Array<{ value: number | null; label: string }> = [
			{ value: null, label: `Source — ${resolution.sourceWidth}×${resolution.sourceHeight}` },
		];

		for (const height of steps) {
			const width = Math.round((height * resolution.sourceWidth) / resolution.sourceHeight);
			if (width >= resolution.sourceWidth) continue;
			options.push({ value: width, label: `${height}p — ${width} wide` });
		}

		for (const option of options) {
			const node = document.createElement('option');
			node.value = option.value === null ? 'source' : String(option.value);
			node.textContent = option.label;
			this.qualitySelect.append(node);
		}

		const desired = resolution.scaled ? String(resolution.width) : 'source';
		this.qualitySelect.value = options.some((option) => option.value === resolution.width)
			? desired
			: current || 'source';

		this.qualityNote.hidden = !resolution.scaled;
		this.qualityNote.textContent = `Playing at ${resolution.width}×${resolution.height} instead of `
			+ `${resolution.sourceWidth}×${resolution.sourceHeight}.`;
	}

	/* ------------------------------------------------------- interactions */

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
