import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	CanvasSink,
	Input,
	LogLevel,
	Logging,
	UrlSource,
	type InputAudioTrack,
	type InputTrack,
	type InputVideoTrack,
	type WrappedAudioBuffer,
	type WrappedCanvas,
} from 'mediabunny';

import { blobByteSource, scanMatroska, urlByteSource, type ByteSource } from './mkv.ts';
import { formatBytes } from './format.ts';
import type { SubtitleCue } from './subtitles.ts';

/* ------------------------------------------------------------------ types */

export type PlayerEventName =
	| 'ready'
	| 'error'
	| 'timeupdate'
	| 'statechange'
	| 'trackschange'
	| 'loading'
	| 'progress'
	| 'subtitles'
	| 'scan'
	| 'buffering'
	| 'ended'
	| 'ratechange'
	| 'volumechange'
	| 'seeked';

export interface VideoTrackInfo {
	index: number;
	track: InputVideoTrack;
	codec: string | null;
	codecParameter: string | null;
	width: number;
	height: number;
	displayWidth: number;
	displayHeight: number;
	rotation: number;
	bitrate: number | null;
	name: string | null;
	language: string;
	isDefault: boolean;
	decodable: boolean;
}

export interface AudioTrackInfo {
	index: number;
	track: InputAudioTrack;
	codec: string | null;
	codecParameter: string | null;
	channels: number;
	sampleRate: number;
	bitrate: number | null;
	name: string | null;
	language: string;
	isDefault: boolean;
	decodable: boolean;
}

export interface AudioChannelState {
	info: AudioTrackInfo;
	enabled: boolean;
	volume: number;
}

export interface EmbeddedSubtitleTrack {
	id: string;
	name: string;
	language: string;
	cues: SubtitleCue[];
}

export interface MediaSummary {
	name: string;
	size: number;
	container: string | null;
	duration: number;
	width: number | null;
	height: number | null;
	tags: Record<string, string>;
}

interface AudioChannel extends AudioChannelState {
	sink: AudioBufferSink | null;
	gain: GainNode | null;
	iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null;
	nodes: Set<AudioBufferSourceNode>;
	token: number;
	decodedBuffers: number;
}

/* -------------------------------------------------------------- utilities */

const CHANNEL_LAYOUTS: Record<number, string> = {
	1: 'Mono',
	2: 'Stereo',
	3: '2.1',
	4: 'Quad',
	5: '5.0',
	6: '5.1',
	7: '6.1',
	8: '7.1',
};

export function describeChannels(channels: number): string {
	return CHANNEL_LAYOUTS[channels] ?? `${channels}ch`;
}

/** Extra WebCodecs decoders shipped as separate packages (loaded on demand). */
const OPTIONAL_DECODERS: Record<string, () => Promise<void>> = {
	ac3: async () => {
		const { registerAc3Decoder } = await import('@mediabunny/ac3');
		registerAc3Decoder();
	},
	eac3: async () => {
		const { registerAc3Decoder } = await import('@mediabunny/ac3');
		registerAc3Decoder();
	},
	dts: async () => {
		const { registerDtsDecoder } = await import('@mediabunny/dts');
		registerDtsDecoder();
	},
	prores: async () => {
		const { registerProresDecoder } = await import('@mediabunny/prores');
		registerProresDecoder();
	},
};

const loadedDecoders = new Set<string>();

async function ensureDecoder(codec: string | null): Promise<void> {
	if (!codec) return;
	const loader = OPTIONAL_DECODERS[codec];
	if (!loader || loadedDecoders.has(codec)) return;
	loadedDecoders.add(codec);
	try {
		await loader();
	} catch (error) {
		loadedDecoders.delete(codec);
		console.warn(`Could not load the ${codec} decoder`, error);
	}
}

/**
 * A byte source for servers that cannot serve ranges: the file is downloaded
 * once in the background and then served from memory.
 */
function cachingByteSource(
	url: string,
	requestInit: RequestInit | undefined,
	onProgress?: (loaded: number, total: number | null) => void,
): ByteSource {
	let blob: Blob | null = null;
	let pending: Promise<Blob> | null = null;

	const load = (): Promise<Blob> => {
		if (!pending) {
			pending = downloadToBlob(url, requestInit, (loaded, total) => onProgress?.(loaded, total)).catch(
				(error) => {
					pending = null;
					throw error;
				},
			);
		}
		return pending;
	};

	return {
		get size() {
			return blob?.size ?? 0;
		},
		async ready() {
			blob = await load();
		},
		async slice(start, end) {
			if (!blob) blob = await load();
			return new Uint8Array(await blob.slice(start, end).arrayBuffer());
		},
	};
}

/* ----------------------------------------------------------------- player */
export interface LoadOptions {
	/** Additional fetch options used when the source is a URL. */
	requestInit?: RequestInit;
	/** Largest file (in bytes) that may be kept fully in memory for servers without range support. */
	fullCacheLimit?: number;
}

/** How a remote file is being read. */
export type StreamingMode =
	| 'local'
	| 'ranged'
	| 'cached'
	| 'downloaded';

export interface SourceCapabilities {
	/** Whether the server answers range requests with 206 Partial Content. */
	supportsRanges: boolean;
	/** Whether the server actually returns the requested bytes (some hosts lie). */
	reliableRanges: boolean;
	/** Size of the resource in bytes, if the server told us. */
	size: number | null;
}

const DEFAULT_FULL_CACHE_LIMIT = 512 * 2 ** 20; // 512 MiB

interface RangeResponse {
	status: number;
	contentRange: string | null;
	bytes: Uint8Array | null;
}

async function requestRange(
	url: string,
	requestInit: RequestInit | undefined,
	range: string,
): Promise<RangeResponse | null> {
	try {
		const response = await fetch(url, {
			...requestInit,
			// The probe's body is discarded, so it must not end up in the HTTP cache —
			// a cached, cancelled response would make later requests return no data.
			cache: 'no-store',
			headers: { ...(requestInit?.headers as Record<string, string> | undefined), Range: range },
		});

		if (response.status === 206) {
			// The probe windows are tiny, so reading them is cheap.
			const buffer = await response.arrayBuffer();
			return {
				status: response.status,
				contentRange: response.headers.get('Content-Range'),
				bytes: new Uint8Array(buffer),
			};
		}

		await response.body?.cancel().catch(() => {});
		return { status: response.status, contentRange: response.headers.get('Content-Range'), bytes: null };
	} catch {
		return null;
	}
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (!a || !b || a.length === 0 || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Checks whether the server supports range requests, and whether it actually
 * returns the requested bytes.
 *
 * Some hosts answer range requests with `206 Partial Content` but ignore the
 * requested offset, or send the whole file every time. Demuxing such a
 * response yields a broken file (often with missing tracks), so the ranges are
 * verified against a second request near the end of the file.
 */
async function probeSource(
	url: string,
	requestInit?: RequestInit,
): Promise<SourceCapabilities> {
	const first = await requestRange(url, requestInit, 'bytes=0-1');
	if (!first) {
		return { supportsRanges: false, reliableRanges: false, size: null };
	}

	if (first.status !== 206) {
		// The server ignores Range headers entirely.
		const size = await sizeFromContentLength(url, requestInit);
		return { supportsRanges: false, reliableRanges: false, size };
	}

	const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(first.contentRange ?? '');
	if (!match) {
		return { supportsRanges: false, reliableRanges: false, size: null };
	}

	const start = Number(match[1]);
	const size = match[3] === '*' ? null : Number(match[3]);

	if (start !== 0) {
		// The server answered with a different range than requested.
		return { supportsRanges: false, reliableRanges: false, size };
	}

	if (size === null) {
		return { supportsRanges: true, reliableRanges: true, size: null };
	}

	// Verify that a range near the end of the file is honoured as well.
	const tailStart = Math.max(0, size - 32);
	const tail = await requestRange(url, requestInit, `bytes=${tailStart}-${size - 1}`);
	if (!tail || tail.status !== 206) {
		return { supportsRanges: true, reliableRanges: false, size };
	}

	const tailMatch = /bytes\s+(\d+)-(\d+)\//i.exec(tail.contentRange ?? '');
	if (!tailMatch || Number(tailMatch[1]) !== tailStart || Number(tailMatch[2]) !== size - 1) {
		return { supportsRanges: true, reliableRanges: false, size };
	}

	// Some hosts answer every range request with the very first bytes while
	// still echoing a correct Content-Range header. Compare the head and the
	// tail to catch that.
	const head = await requestRange(url, requestInit, 'bytes=0-31');
	if (head && head.status === 206 && sameBytes(head.bytes, tail.bytes)) {
		return { supportsRanges: true, reliableRanges: false, size };
	}

	return { supportsRanges: true, reliableRanges: true, size };
}

/** Reads the content length of a resource without downloading it. */
async function sizeFromContentLength(url: string, requestInit?: RequestInit): Promise<number | null> {
	try {
		const response = await fetch(url, {
			...requestInit,
			method: 'HEAD',
			cache: 'no-store',
		});
		const length = response.headers.get('Content-Length');
		return length ? Number(length) : null;
	} catch {
		return null;
	}
}

/** Downloads a whole resource into a blob, reporting progress along the way. */
async function downloadToBlob(
	url: string,
	requestInit: RequestInit | undefined,
	onProgress: (loaded: number, total: number | null) => void,
): Promise<Blob> {
	const response = await fetch(url, requestInit);
	if (!response.ok) {
		throw new Error(`The server responded with ${response.status} ${response.statusText}.`);
	}

	const expected = Number(response.headers.get('Content-Length')) || null;
	const total = expected;
	if (!response.body) {
		const blob = await response.blob();
		onProgress(blob.size, blob.size);
		return blob;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			loaded += value.byteLength;
			onProgress(loaded, total);
		}
	}

	const blob = new Blob(chunks as BlobPart[]);
	if (blob.size === 0) {
		throw new Error('The server returned an empty response.');
	}

	// A truncated download would produce a file that is missing tracks, so it
	// has to be treated as a failure.
	if (expected !== null && blob.size !== expected) {
		throw new Error(
			`The download was incomplete (${formatBytes(blob.size)} of ${formatBytes(expected)}). `
			+ 'The server closed the connection early — please try again.',
		);
	}

	onProgress(blob.size, blob.size);
	return blob;
}

export class MediaPlayer {
	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;

	private input: Input | null = null;
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;

	private videoTracks: VideoTrackInfo[] = [];
	private audioChannels: AudioChannel[] = [];
	private activeVideoIndex = -1;

	private videoSink: CanvasSink | null = null;
	private videoIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
	private nextFrame: WrappedCanvas | null = null;
	private videoToken = 0;

	private firstTimestamp = 0;
	private endTimestamp = 0;

	/** Media time that corresponds to `anchorContextTime`. */
	private anchorMediaTime = 0;
	/** AudioContext time the anchor was taken at. */
	private anchorContextTime = 0;

	private playing = false;
	private rate = 1;
	private volume = 1;
	private muted = false;
	private buffering = false;
	private loaded = false;
	private disposed = false;
	private generation = 0;
	private streamingMode: StreamingMode = 'local';
	private remoteSize: number | null = null;
	private remoteUrl: string | null = null;
	private remoteName = '';
	private remoteRequestInit: RequestInit | undefined;
	private restoreLogLevel: LogLevel | null = null;
	private embeddedSubtitleTracks: EmbeddedSubtitleTrack[] = [];
	private containerTracks = { video: 0, audio: 0, subtitle: 0, total: 0 };
	private scanSource: ByteSource | null = null;
	private scanToken = 0;
	private retriedWithDownload = false;

	private rafHandle = 0;
	private readonly listeners = new Map<PlayerEventName, Set<(payload?: unknown) => void>>();

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Could not create a 2D canvas context');
		this.context = context;
		this.rafHandle = requestAnimationFrame(this.renderLoop);
	}

	/* ----------------------------------------------------------- events */

	on(event: PlayerEventName, listener: (payload?: unknown) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => set!.delete(listener);
	}

	private emit(event: PlayerEventName, payload?: unknown): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of set) {
			try {
				listener(payload);
			} catch (error) {
				console.error(`Listener for "${event}" failed`, error);
			}
		}
	}

	/* ------------------------------------------------------------ state */

	get isPlaying(): boolean {
		return this.playing;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	get isBuffering(): boolean {
		return this.buffering;
	}

	get duration(): number {
		return this.endTimestamp;
	}

	get startTime(): number {
		return this.firstTimestamp;
	}

	get playbackRate(): number {
		return this.rate;
	}

	get currentVolume(): number {
		return this.muted ? 0 : this.volume;
	}

	get isMuted(): boolean {
		return this.muted;
	}

	get videoTrackInfos(): VideoTrackInfo[] {
		return this.videoTracks;
	}

	get audioChannelStates(): AudioChannelState[] {
		return this.audioChannels.map(({ info, enabled, volume }) => ({ info, enabled, volume }));
	}

	/** Number of audio buffers decoded per audio track (diagnostics). */
	get audioDecodeCounts(): number[] {
		return this.audioChannels.map((channel) => channel.decodedBuffers);
	}

	/** How the current media is being read. */
	get mode(): StreamingMode {
		return this.streamingMode;
	}

	/** Size of the remote file in bytes, if known. */
	get size(): number | null {
		return this.remoteSize;
	}

	/** URL of the currently loaded remote file, if any. */
	get remoteSource(): string | null {
		return this.remoteUrl;
	}

	/** Subtitle tracks that were found inside the media file itself. */
	get embeddedSubtitles(): EmbeddedSubtitleTrack[] {
		return this.embeddedSubtitleTracks;
	}

	/**
	 * Number of tracks of each type as declared by the container. This can
	 * differ from what the demuxer reports when a file is delivered incompletely.
	 */
	get containerTrackCounts(): { video: number; audio: number; subtitle: number; total: number } {
		return this.containerTracks;
	}

	/**
	 * Re-reads the current remote file, optionally forcing a full download.
	 * Useful when a server delivers the file in a way that confuses the
	 * demuxer (for example when it ignores range requests).
	 */
	async reloadRemote(forceDownload = false): Promise<boolean> {
		if (!this.remoteUrl) return false;
		return this.load(this.remoteUrl, this.remoteName, {
			requestInit: this.remoteRequestInit,
			fullCacheLimit: forceDownload ? 0 : undefined,
		});
	}

	get activeVideoIndexValue(): number {
		return this.activeVideoIndex;
	}

	/** Current playback position in seconds (media timeline). */
	getMediaTime(): number {
		if (!this.playing || !this.audioContext) return this.anchorMediaTime;
		const elapsed = this.audioContext.currentTime - this.anchorContextTime;
		return this.anchorMediaTime + elapsed * this.rate;
	}

	/* ----------------------------------------------------------- loading */

	async load(source: File | string, name: string, options: LoadOptions = {}): Promise<boolean> {
		this.teardownMedia();
		const generation = ++this.generation;
		this.emit('loading', { name });

		try {
			let mediaSource: BlobSource | UrlSource;

			if (typeof source === 'string') {
				this.remoteUrl = source;
				this.remoteName = name;
				this.remoteRequestInit = options.requestInit;
				mediaSource = await this.createRemoteSource(source, options, generation);
			} else {
				this.streamingMode = 'local';
				this.remoteUrl = null;
				this.remoteName = '';
				this.scanSource = blobByteSource(source);
				mediaSource = new BlobSource(source);
			}

			if (generation !== this.generation) return false;

			const input = new Input({ source: mediaSource, formats: ALL_FORMATS });
			this.input = input;

			const videoTracks = await input.getVideoTracks();
			const audioTracks = await input.getAudioTracks();

			if (generation !== this.generation) {
				input.dispose();
				return false;
			}

			if (videoTracks.length === 0 && audioTracks.length === 0) {
				throw new Error('No playable audio or video tracks were found in this file.');
			}

			// Register the optional WASM decoders for the codecs we actually need.
			await Promise.all([
				...videoTracks.map(async (t) => ensureDecoder(await t.getCodec())),
				...audioTracks.map(async (t) => ensureDecoder(await t.getCodec())),
			]);

			if (generation !== this.generation) return false;

			this.videoTracks = await Promise.all(
				videoTracks.map(async (track, index) => ({
					index,
					track,
					codec: await track.getCodec(),
					codecParameter: await track.getCodecParameterString(),
					width: await track.getDisplayWidth(),
					height: await track.getDisplayHeight(),
					displayWidth: await track.getDisplayWidth(),
					displayHeight: await track.getDisplayHeight(),
					rotation: await track.getRotation(),
					bitrate: await track.getBitrate(),
					name: await track.getName(),
					language: await track.getLanguageCode(),
					isDefault: (await track.getDisposition()).default ?? false,
					decodable: await track.canDecode(),
				})),
			);

			this.audioChannels = await Promise.all(
				audioTracks.map(async (track, index) => {
					const info: AudioTrackInfo = {
						index,
						track,
						codec: await track.getCodec(),
						codecParameter: await track.getCodecParameterString(),
						channels: await track.getNumberOfChannels(),
						sampleRate: await track.getSampleRate(),
						bitrate: await track.getBitrate(),
						name: await track.getName(),
						language: await track.getLanguageCode(),
						isDefault: (await track.getDisposition()).default ?? false,
						decodable: await track.canDecode(),
					};
					return {
						info,
						enabled: false,
						volume: 1,
						sink: null,
						gain: null,
						iterator: null,
						nodes: new Set(),
						token: 0,
						decodedBuffers: 0,
					};
				}),
			);

			const allTracks: InputTrack[] = [
				...this.videoTracks.map((t) => t.track),
				...this.audioChannels.map((c) => c.info.track),
			];

			this.firstTimestamp = Math.max(await input.getFirstTimestamp(allTracks), 0);
			const metadataDuration = await input.getDurationFromMetadata(allTracks, { skipLiveWait: true });
			const computedDuration = metadataDuration ?? (await input.computeDuration(allTracks, { skipLiveWait: true }));
			this.endTimestamp = Math.max(this.firstTimestamp, computedDuration || 0);

			this.anchorMediaTime = this.firstTimestamp;
			this.anchorContextTime = 0;

			// Pick a default video track: decodable first, then the one flagged as default.
			const preferredVideo =
				this.videoTracks.find((t) => t.decodable && t.isDefault) ??
				this.videoTracks.find((t) => t.decodable) ??
				this.videoTracks[0] ??
				null;

			if (preferredVideo) {
				await this.activateVideoTrack(preferredVideo.index);
			}

			// Pick a default audio track: decodable + flagged default, else the first decodable one.
			const preferredAudio =
				this.audioChannels.find((c) => c.info.decodable && c.info.isDefault) ??
				this.audioChannels.find((c) => c.info.decodable) ??
				this.audioChannels[0] ??
				null;

			if (preferredAudio) {
				await this.setAudioTrackEnabled(preferredAudio.info.index, true);
			}

			await this.ensureAudioGraph();
			this.loaded = true;
			this.emit('trackschange');
			this.emit('statechange');
			this.emit('ready', {
				videoTracks: this.videoTracks,
				audioTracks: this.audioChannels.map((c) => c.info),
			});

			// Look for subtitle tracks the demuxer does not expose (Matroska).
			void this.scanForSubtitles(generation);

			return true;
		} catch (error) {
			console.error(error);
			this.emit('error', error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}

	/**
	 * Scans the media container for subtitle tracks that the demuxer does not
	 * expose (Matroska subtitle tracks) and reports them.
	 */
	private async scanForSubtitles(generation: number): Promise<void> {
		const source = this.scanSource;
		if (!source) return;

		const token = ++this.scanToken;
		try {
			const result = await scanMatroska(source, {
				durationHint: this.endTimestamp || null,
			});
			if (token !== this.scanToken || generation !== this.generation) return;

			this.containerTracks = {
				video: result.tracks.filter((track) => track.type === 'video').length,
				audio: result.tracks.filter((track) => track.type === 'audio').length,
				subtitle: result.tracks.filter((track) => track.type === 'subtitle').length,
				total: result.tracks.length,
			};
			this.emit('scan', this.containerTracks);

			// The container knows about more audio tracks than the demuxer found:
			// the file was most likely delivered incompletely. Fetch it completely
			// and parse it again.
			if (
				this.remoteUrl &&
				!this.retriedWithDownload &&
				this.containerTracks.audio > this.audioChannels.length
			) {
				this.retriedWithDownload = true;
				console.info(
					`The container declares ${this.containerTracks.audio} audio tracks but only `
					+ `${this.audioChannels.length} could be read — downloading the file completely.`,
				);
				void this.reloadRemote(true);
				return;
			}

			const tracks: EmbeddedSubtitleTrack[] = result.subtitles
				.filter((track) => track.cues.length > 0)
				.map((track, index) => ({
					id: `embedded-${index}`,
					name: track.name ?? `Subtitle ${index + 1}`,
					language: track.language,
					cues: track.cues,
				}));

			this.embeddedSubtitleTracks = tracks;
			if (tracks.length) this.emit('subtitles', tracks);
		} catch (error) {
			console.warn('Scanning the container for subtitles failed', error);
		}
	}

	/**
	 * Builds the source for a remote file.
	 *
	 * Servers that do not implement range requests force sequential streaming,
	 * which makes seeking impossible once the cache has moved past the target
	 * position. For those servers the file is either fully cached in memory
	 * (small files) or downloaded first (large files) so that seeking keeps
	 * working.
	 */
	private async createRemoteSource(
		url: string,
		options: LoadOptions,
		generation: number,
	): Promise<UrlSource | BlobSource> {
		const requestInit = options.requestInit;
		const capabilities = await probeSource(url, requestInit);
		if (generation !== this.generation) throw new Error('Cancelled');

		if (capabilities.supportsRanges && capabilities.reliableRanges) {
			this.streamingMode = 'ranged';
			this.remoteSize = capabilities.size;
			this.scanSource = urlByteSource(url, requestInit);
			return new UrlSource(url, requestInit ? { requestInit } : undefined);
		}

		const limit = options.fullCacheLimit ?? DEFAULT_FULL_CACHE_LIMIT;
		const size = capabilities.size;

		// We handle the missing range support ourselves, so the library's
		// warning about it would only be noise.
		this.suppressRangeWarning();

		// A server that answers range requests with the wrong bytes produces a
		// broken file, so the only safe option is a full download.
		const rangesUnreliable = capabilities.supportsRanges && !capabilities.reliableRanges;

		if (!rangesUnreliable && size !== null && size <= limit) {
			// Small enough to keep the whole thing in memory: seeking just works.
			this.streamingMode = 'cached';
			this.remoteSize = size;
			// Subtitles are read from a separate background copy, because the
			// server cannot serve the byte ranges the scanner needs.
			this.scanSource = cachingByteSource(url, requestInit);
			return new UrlSource(url, {
				...(requestInit ? { requestInit } : {}),
				maxCacheSize: Infinity,
			});
		}

		// Large or unknown: download it first, then play from the blob.
		this.streamingMode = 'downloaded';
		this.emit('loading', { name: url, downloading: true });

		const blob = await downloadToBlob(url, requestInit, (loaded, total) => {
			this.emit('progress', { loaded, total });
		});
		if (generation !== this.generation) throw new Error('Cancelled');

		this.remoteSize = blob.size;
		this.scanSource = blobByteSource(blob);
		return new BlobSource(blob);
	}

	/** Silences the library warning about servers without range support. */
	private suppressRangeWarning(): void {
		if (this.restoreLogLevel !== null) return;
		this.restoreLogLevel = Logging.level;
		Logging.level = LogLevel.Errors;
		console.info(
			'The server does not support range requests — the file is buffered locally so that seeking keeps working.',
		);
	}

	private restoreLogging(): void {
		if (this.restoreLogLevel === null) return;
		Logging.level = this.restoreLogLevel;
		this.restoreLogLevel = null;
	}

	/** Reads basic metadata for the info panel. */
	async readSummary(source: File | string, name: string): Promise<MediaSummary> {
		const summary: MediaSummary = {
			name,
			size: typeof source === 'string' ? this.remoteSize ?? 0 : source.size,
			container: null,
			duration: this.endTimestamp,
			width: null,
			height: null,
			tags: {},
		};

		try {
			if (typeof source === 'string') {
				// Re-reading a remote file would trigger a second download; skip it.
				return summary;
			}
			const input = new Input({
				source: new BlobSource(source),
				formats: ALL_FORMATS,
			});
			summary.container = (await input.getFormat())?.name ?? null;
			const tags = await input.getMetadataTags();
			for (const [key, value] of Object.entries(tags)) {
				if (typeof value === 'string' && value) summary.tags[key] = value;
			}
			const videoTrack = await input.getPrimaryVideoTrack();
			if (videoTrack) {
				summary.width = await videoTrack.getDisplayWidth();
				summary.height = await videoTrack.getDisplayHeight();
			}
			input.dispose();
		} catch {
			/* metadata is best-effort only */
		}

		return summary;
	}

	/* ------------------------------------------------------------- audio */

	private async ensureAudioGraph(): Promise<void> {
		if (!this.audioContext) {
			this.audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
			this.masterGain = this.audioContext.createGain();
			this.masterGain.gain.value = this.currentVolume;
			this.masterGain.connect(this.audioContext.destination);
		}
		for (const channel of this.audioChannels) {
			if (channel.gain) continue;
			const gain = this.audioContext.createGain();
			gain.gain.value = channel.enabled ? channel.volume : 0;
			gain.connect(this.masterGain!);
			channel.gain = gain;
		}
	}

	async setAudioTrackEnabled(index: number, enabled: boolean): Promise<void> {
		const channel = this.audioChannels[index];
		if (!channel) return;

		if (enabled && !channel.info.decodable) {
			this.emit('error', new Error(`The audio track "${channel.info.name ?? channel.info.language}" uses an unsupported codec (${channel.info.codec ?? 'unknown'}).`));
			return;
		}

		await this.ensureAudioGraph();
		channel.enabled = enabled;

		if (channel.gain) {
			const target = enabled ? channel.volume : 0;
			channel.gain.gain.setTargetAtTime(target, this.audioContext!.currentTime, 0.02);
		}

		if (enabled) {
			if (!channel.sink) {
				channel.sink = new AudioBufferSink(channel.info.track);
			}
			if (this.playing) {
				this.startAudioChannel(channel);
			}
		} else {
			this.stopAudioChannel(channel);
		}

		this.emit('trackschange');
	}

	setAudioTrackVolume(index: number, volume: number): void {
		const channel = this.audioChannels[index];
		if (!channel) return;
		channel.volume = Math.max(0, Math.min(1, volume));
		if (channel.gain && channel.enabled) {
			channel.gain.gain.setTargetAtTime(channel.volume, this.audioContext!.currentTime, 0.02);
		}
		this.emit('trackschange');
	}

	/** Enables exactly one audio track and disables the rest. */
	async soloAudioTrack(index: number): Promise<void> {
		for (const channel of this.audioChannels) {
			await this.setAudioTrackEnabled(channel.info.index, channel.info.index === index);
		}
	}

	private stopAudioChannel(channel: AudioChannel): void {
		channel.token++;
		const iterator = channel.iterator;
		channel.iterator = null;
		if (iterator) {
			void iterator.return(undefined).catch(() => {});
		}
		for (const node of channel.nodes) {
			try {
				node.stop();
			} catch {
				/* already stopped */
			}
		}
		channel.nodes.clear();
	}

	private startAudioChannel(channel: AudioChannel): void {
		const sink = channel.sink;
		const context = this.audioContext;
		if (!sink || !context) return;

		this.stopAudioChannel(channel);
		const token = ++channel.token;
		channel.iterator = sink.buffers(Math.max(this.firstTimestamp, this.getMediaTime()));

		void (async () => {
			try {
				for await (const { buffer, timestamp } of channel.iterator!) {
					if (token !== channel.token || this.disposed) break;
					channel.decodedBuffers += 1;

					const node = context.createBufferSource();
					node.buffer = buffer;
					node.playbackRate.value = this.rate;
					node.connect(channel.gain!);

					const target = this.mediaTimeToContextTime(timestamp);
					if (target >= context.currentTime) {
						node.start(target);
					} else {
						const offset = (context.currentTime - target) * this.rate;
						if (offset >= buffer.duration) continue;
						node.start(context.currentTime, offset);
					}

					channel.nodes.add(node);
					node.onended = () => channel.nodes.delete(node);

					// Don't run too far ahead of the playhead.
					const ahead = timestamp - this.getMediaTime();
					if (ahead >= 1) {
						await waitFor(() => timestamp - this.getMediaTime() < 1);
					}
				}
			} catch (error) {
				if (token === channel.token) {
					console.error('Audio decoding failed', error);
					this.emit('error', error instanceof Error ? error : new Error(String(error)));
				}
			}
		})();
	}

	/** Converts a media timestamp into an AudioContext timestamp. */
	private mediaTimeToContextTime(mediaTime: number): number {
		if (!this.audioContext) return mediaTime;
		return this.anchorContextTime + (mediaTime - this.anchorMediaTime) / this.rate;
	}

	/* ------------------------------------------------------------- video */

	async selectVideoTrack(index: number): Promise<void> {
		const track = this.videoTracks[index];
		if (!track || index === this.activeVideoIndex) return;
		await this.activateVideoTrack(index);
		this.emit('trackschange');
	}

	private async activateVideoTrack(index: number): Promise<void> {
		const info = this.videoTracks[index];
		if (!info) return;

		this.activeVideoIndex = index;
		this.videoToken++;
		const token = this.videoToken;

		await this.videoIterator?.return(undefined).catch(() => {});
		this.videoIterator = null;
		this.nextFrame = null;

		if (!info.decodable) {
			this.videoSink = null;
			this.canvas.width = 640;
			this.canvas.height = 360;
			this.context.fillStyle = '#000';
			this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
			return;
		}

		const canBeTransparent = await info.track.canBeTransparent().catch(() => false);
		this.videoSink = new CanvasSink(info.track, {
			poolSize: 2,
			fit: 'contain',
			alpha: canBeTransparent,
		});

		this.canvas.width = info.displayWidth || info.width || 1280;
		this.canvas.height = info.displayHeight || info.height || 720;

		await this.startVideoIterator(token);
	}

	private async startVideoIterator(token = this.videoToken): Promise<void> {
		const sink = this.videoSink;
		if (!sink) return;

		// Ending the previous iterator releases the video samples it still holds.
		const previous = this.videoIterator;
		this.videoIterator = null;
		if (previous) {
			try {
				await previous.return(undefined);
			} catch {
				/* the iterator was already finished */
			}
		}
		if (token !== this.videoToken) return;

		const iterator = sink.canvases(this.getMediaTime());
		this.videoIterator = iterator;

		try {
			const first = (await iterator.next()).value ?? null;
			if (token !== this.videoToken) return;
			const second = (await iterator.next()).value ?? null;
			if (token !== this.videoToken) return;

			this.nextFrame = second;
			if (first) {
				this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
				this.context.drawImage(first.canvas as CanvasImageSource, 0, 0);
			}
		} catch (error) {
			if (token === this.videoToken) {
				console.error('Video decoding failed', error);
				this.emit('error', error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private async updateNextFrame(): Promise<void> {
		const token = this.videoToken;
		const iterator = this.videoIterator;
		if (!iterator) return;

		while (true) {
			let frame: WrappedCanvas | null;
			try {
				frame = (await iterator.next()).value ?? null;
			} catch (error) {
				if (token === this.videoToken) {
					console.error('Video decoding failed', error);
					this.emit('error', error instanceof Error ? error : new Error(String(error)));
				}
				return;
			}

			if (token !== this.videoToken || this.disposed) return;
			if (!frame) {
				if (this.playing) this.setBuffering(true);
				return;
			}

			this.setBuffering(false);
			const time = this.getMediaTime();
			if (frame.timestamp <= time) {
				this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
				this.context.drawImage(frame.canvas as CanvasImageSource, 0, 0);
			} else {
				this.nextFrame = frame;
				return;
			}
		}
	}

	private setBuffering(value: boolean): void {
		if (this.buffering === value) return;
		this.buffering = value;
		this.emit('buffering', value);
	}

	/* --------------------------------------------------------- rendering */

	private renderLoop = (): void => {
		this.rafHandle = requestAnimationFrame(this.renderLoop);
		if (!this.loaded || this.disposed) return;

		const time = this.getMediaTime();

		if (this.playing && time >= this.endTimestamp) {
			this.pause();
			this.anchorMediaTime = this.endTimestamp;
			this.emit('ended');
		}

		if (this.nextFrame && this.nextFrame.timestamp <= time) {
			this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
			this.context.drawImage(this.nextFrame.canvas as CanvasImageSource, 0, 0);
			this.nextFrame = null;
			void this.updateNextFrame();
		}

		this.emit('timeupdate', time);
	};

	/* --------------------------------------------------------- transport */

	async play(): Promise<void> {
		if (!this.loaded) return;
		await this.ensureAudioGraph();

		if (this.audioContext!.state === 'suspended') {
			await this.audioContext!.resume();
		}

		if (this.getMediaTime() >= this.endTimestamp - 0.05) {
			await this.seek(this.firstTimestamp);
		}

		const now = this.getMediaTime();
		this.anchorMediaTime = now;
		this.anchorContextTime = this.audioContext!.currentTime;
		this.playing = true;

		for (const channel of this.audioChannels) {
			if (channel.enabled) this.startAudioChannel(channel);
		}

		this.emit('statechange');
	}

	pause(): void {
		if (!this.playing) return;
		this.anchorMediaTime = this.getMediaTime();
		this.playing = false;

		for (const channel of this.audioChannels) {
			this.stopAudioChannel(channel);
		}

		this.emit('statechange');
	}

	togglePlay(): void {
		if (this.playing) {
			this.pause();
		} else {
			void this.play();
		}
	}

	async seek(time: number): Promise<void> {
		if (!this.loaded) return;
		const clamped = Math.max(this.firstTimestamp, Math.min(time, this.endTimestamp));
		this.anchorMediaTime = clamped;
		if (this.audioContext) this.anchorContextTime = this.audioContext.currentTime;

		await this.startVideoIterator();

		for (const channel of this.audioChannels) {
			if (channel.enabled && this.playing) this.startAudioChannel(channel);
		}

		this.emit('seeked', clamped);
		this.emit('timeupdate', clamped);
	}

	async setPlaybackRate(rate: number): Promise<void> {
		const next = Math.max(0.1, Math.min(4, rate));
		if (next === this.rate) return;

		if (this.playing) {
			const now = this.getMediaTime();
			this.anchorMediaTime = now;
			if (this.audioContext) this.anchorContextTime = this.audioContext.currentTime;
		}

		this.rate = next;
		this.emit('ratechange', next);

		// Already scheduled buffers keep the old rate, so reschedule them.
		if (this.playing) {
			for (const channel of this.audioChannels) {
				if (channel.enabled) this.startAudioChannel(channel);
			}
		}
	}

	setVolume(volume: number): void {
		this.volume = Math.max(0, Math.min(1, volume));
		this.applyVolume();
		this.emit('volumechange', this.currentVolume);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.applyVolume();
		this.emit('volumechange', this.currentVolume);
	}

	toggleMuted(): void {
		this.setMuted(!this.muted);
	}

	private applyVolume(): void {
		if (!this.masterGain || !this.audioContext) return;
		this.masterGain.gain.setTargetAtTime(this.currentVolume, this.audioContext.currentTime, 0.02);
	}

	/* ---------------------------------------------------------- teardown */

	private teardownMedia(): void {
		this.playing = false;
		this.loaded = false;
		this.setBuffering(false);
		this.videoToken++;
		this.generation++;
		this.restoreLogging();
		this.retriedWithDownload = false;

		for (const channel of this.audioChannels) {
			this.stopAudioChannel(channel);
		}
		this.audioChannels = [];
		this.videoTracks = [];
		this.activeVideoIndex = -1;
		this.streamingMode = 'local';
		this.remoteSize = null;

		void this.videoIterator?.return(undefined).catch(() => {});
		this.videoIterator = null;
		this.nextFrame = null;
		this.videoSink = null;

		this.input?.dispose();
		this.input = null;
	}

	dispose(): void {
		this.disposed = true;
		this.teardownMedia();
		cancelAnimationFrame(this.rafHandle);
		void this.audioContext?.close();
		this.audioContext = null;
		this.masterGain = null;
		this.listeners.clear();
	}
}

function waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
	return new Promise((resolve) => {
		const started = performance.now();
		const tick = () => {
			if (condition() || performance.now() - started > timeout) {
				resolve();
				return;
			}
			setTimeout(tick, 50);
		};
		tick();
	});
}
