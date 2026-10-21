/**
 * Matroska (MKV/WebM) parser.
 *
 * MediaBunny does not expose Matroska subtitle tracks and chapters, so this
 * module reads the container directly. It provides:
 *  - the full track list (video, audio, subtitle) with their metadata,
 *  - chapter markers,
 *  - the text cues of embedded subtitle tracks.
 *
 * Only the parts of EBML needed for that are implemented.
 */

import { parseSubtitleText, type SubtitleCue } from './subtitles.ts';

export interface Chapter {
	title: string;
	start: number;
	end: number | null;
	language: string;
}

export type MkvTrackType = 'video' | 'audio' | 'subtitle' | 'other';

export interface MkvTrack {
	/** Track number as stored in the container. */
	number: number;
	type: MkvTrackType;
	codecId: string;
	language: string;
	name: string | null;
	enabled: boolean;
	isDefault: boolean;
	forced: boolean;
	channels: number | null;
	sampleRate: number | null;
	width: number | null;
	height: number | null;
}

export interface MkvSubtitleTrack extends MkvTrack {
	cues: SubtitleCue[];
}

export interface MkvScanResult {
	tracks: MkvTrack[];
	subtitles: MkvSubtitleTrack[];
	chapters: Chapter[];
	timestampScale: number;
	/** True when the file starts with the Matroska magic number. */
	isMatroska: boolean;
}

/* --------------------------------------------------------------- EBML ids */

const ID = {
	SEGMENT: 0x18538067,
	TRACKS: 0x1654ae6b,
	TRACK_ENTRY: 0xae,
	TRACK_NUMBER: 0xd7,
	TRACK_TYPE: 0x83,
	CODEC_ID: 0x86,
	CODEC_PRIVATE: 0x63a2,
	LANGUAGE: 0x22b59c,
	LANGUAGE_IETF: 0x22b59d,
	NAME: 0x536e,
	FLAG_ENABLED: 0xb9,
	FLAG_DEFAULT: 0x88,
	FLAG_FORCED: 0x55aa,
	VIDEO: 0xe0,
	PIXEL_WIDTH: 0xb0,
	PIXEL_HEIGHT: 0xba,
	AUDIO: 0xe1,
	SAMPLING_FREQUENCY: 0xb5,
	CHANNELS: 0x9f,
	CLUSTER: 0x1f43b675,
	TIMECODE: 0xe7,
	SIMPLE_BLOCK: 0xa3,
	BLOCK_GROUP: 0xa0,
	BLOCK: 0xa1,
	BLOCK_DURATION: 0x9b,
	INFO: 0x1549a966,
	TIMESTAMP_SCALE: 0x2ad7b1,
	CHAPTERS: 0x1043a770,
	EDITION_ENTRY: 0x45b9,
	CHAPTER_ATOM: 0xb6,
	CHAPTER_TIME_START: 0x91,
	CHAPTER_TIME_END: 0x92,
	CHAPTER_DISPLAY: 0x80,
	CHAP_STRING: 0x85,
	CHAP_LANGUAGE: 0x437c,
} as const;

/** Elements we descend into while searching. */
const CONTAINERS = new Set<number>([ID.SEGMENT, ID.EDITION_ENTRY, ID.CHAPTER_ATOM, ID.CHAPTER_DISPLAY]);

const DEFAULT_TIMESTAMP_SCALE = 1_000_000;
const WINDOW_SIZE = 16 * 1024 * 1024;

/* ------------------------------------------------------------ primitives */

/** A random-access byte source: a local blob or a range-capable HTTP server. */
export interface ByteSource {
	readonly size: number;
	slice(start: number, end: number): Promise<Uint8Array>;
	/** Resolves once the size is known (for sources that download on demand). */
	ready?(): Promise<void>;
}

/** Wraps a Blob/File as a byte source. */
export function blobByteSource(blob: Blob): ByteSource {
	return {
		size: blob.size,
		async slice(start, end) {
			return new Uint8Array(await blob.slice(start, end).arrayBuffer());
		},
	};
}

/** Reads from an HTTP server using range requests. */
export function urlByteSource(url: string, requestInit?: RequestInit): ByteSource {
	let size = Number.NaN;

	const head = async (): Promise<void> => {
		if (Number.isFinite(size)) return;
		try {
			const response = await fetch(url, { ...requestInit, method: 'HEAD', cache: 'no-store' });
			const length = response.headers.get('Content-Length');
			if (length) size = Number(length);
		} catch {
			size = Number.NaN;
		}
	};

	return {
		get size() {
			return size;
		},
		async ready() {
			await head();
		},
		async slice(start, end) {
			if (!Number.isFinite(size)) await head();
			const response = await fetch(url, {
				...requestInit,
				headers: {
					...(requestInit?.headers as Record<string, string> | undefined),
					Range: `bytes=${start}-${Math.max(start, end - 1)}`,
				},
			});
			if (!response.ok && response.status !== 206) {
				throw new Error(`The server responded with ${response.status}.`);
			}
			const length = response.headers.get('Content-Length');
			const total = response.headers.get('Content-Range');
			if (total) {
				const match = /\/(\d+)\s*$/.exec(total);
				if (match) size = Number(match[1]);
			} else if (length) {
				size = start + Number(length);
			}
			return new Uint8Array(await response.arrayBuffer());
		},
	};
}

interface Range {
	start: number;
	end: number;
}

interface ElementHeader {
	id: number;
	idLength: number;
	size: number;
	sizeLength: number;
	unknownSize: boolean;
}

function readElementId(data: Uint8Array, offset: number): { value: number; length: number } | null {
	const first = data[offset];
	if (first === undefined || first === 0) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 4 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 4 || offset + length > data.length) return null;
	let value = 0;
	for (let i = 0; i < length; i++) value = value * 256 + data[offset + i];
	return { value, length };
}

function readElementSize(data: Uint8Array, offset: number): { value: number; length: number; unknown: boolean } | null {
	const first = data[offset];
	if (first === undefined) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 8 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 8 || offset + length > data.length) return null;

	let value = first & (mask - 1);
	let allOnes = value === mask - 1;
	for (let i = 1; i < length; i++) {
		const byte = data[offset + i];
		value = value * 256 + byte;
		if (byte !== 0xff) allOnes = false;
	}
	return { value, length, unknown: allOnes };
}

function readHeader(data: Uint8Array, offset: number): ElementHeader | null {
	const id = readElementId(data, offset);
	if (!id) return null;
	const size = readElementSize(data, offset + id.length);
	if (!size) return null;
	return {
		id: id.value,
		idLength: id.length,
		size: size.value,
		sizeLength: size.length,
		unknownSize: size.unknown,
	};
}

/**
 * Reads an EBML variable-length integer. The leading marker bits encode the
 * length and are not part of the value (same as element sizes).
 */
function readVint(data: Uint8Array, offset: number): { value: number; length: number } | null {
	const first = data[offset];
	if (first === undefined) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 8 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 8 || offset + length > data.length) return null;

	let value = first & (mask - 1);
	for (let i = 1; i < length; i++) value = value * 256 + data[offset + i];
	return { value, length };
}

function readUint(data: Uint8Array, range: Range): number {
	let value = 0;
	for (let i = range.start; i < range.end && i < data.length; i++) value = value * 256 + data[i];
	return value;
}

function readFloat(data: Uint8Array, range: Range): number {
	const size = range.end - range.start;
	try {
		if (size === 4) {
			return new DataView(data.buffer, data.byteOffset + range.start, 4).getFloat32(0, false);
		}
		if (size === 8) {
			return new DataView(data.buffer, data.byteOffset + range.start, 8).getFloat64(0, false);
		}
	} catch {
		/* out of bounds */
	}
	return Number.NaN;
}

function readString(data: Uint8Array, range: Range): string {
	return new TextDecoder('utf-8').decode(data.subarray(range.start, range.end)).replace(/\0+$/, '');
}

async function readRange(source: ByteSource, start: number, end: number): Promise<Uint8Array> {
	return source.slice(start, end);
}

/* ------------------------------------------------------------- iteration */

function* children(data: Uint8Array, range: Range): Generator<{ id: number; range: Range }> {
	let offset = range.start;
	while (offset < range.end) {
		const header = readHeader(data, offset);
		if (!header) return;
		const dataStart = offset + header.idLength + header.sizeLength;
		const dataEnd = header.unknownSize ? range.end : Math.min(range.end, dataStart + header.size);
		yield { id: header.id, range: { start: dataStart, end: dataEnd } };
		if (dataEnd <= offset) return;
		offset = dataEnd;
	}
}

function findElement(data: Uint8Array, start: number, end: number, target: number): Range | null {
	// The requested end can lie beyond the buffer (e.g. the size of a segment
	// that is much larger than the header we read).
	const limit = Math.min(end, data.length);
	let offset = start;
	while (offset < limit) {
		const header = readHeader(data, offset);
		if (!header) return null;
		const dataStart = offset + header.idLength + header.sizeLength;
		const dataEnd = header.unknownSize ? limit : Math.min(limit, dataStart + header.size);
		if (header.id === target) {
			// Return the element's real extent, which can reach beyond the buffer
			// (e.g. a segment that is much larger than the header we read).
			return {
				start: dataStart,
				end: header.unknownSize ? limit : dataStart + header.size,
			};
		}
		if (CONTAINERS.has(header.id)) {
			const found = findElement(data, dataStart, dataEnd, target);
			if (found) return found;
		}
		if (dataEnd <= offset) return null;
		offset = dataEnd;
	}
	return null;
}

/* ------------------------------------------------------- enabled tracks */

export interface PatchedHeader {
	/** The header bytes with disabled tracks turned on. */
	bytes: Uint8Array;
	/** Offset up to which the patched bytes are valid. */
	regionEnd: number;
	/** How many tracks were enabled. */
	enabledTracks: number;
	/** Track numbers that were enabled. */
	enabledTrackNumbers: number[];
}

/**
 * Turns on tracks that the file marks as disabled (`FlagEnabled = 0`).
 *
 * Many releases — especially dual-audio ones — flag the non-default audio and
 * subtitle tracks as disabled. Players like VLC or mpv still show them, but
 * strict demuxers skip them, which would hide half of the tracks. The flag is
 * rewritten in place, so the file keeps its exact length and all offsets stay
 * valid.
 */
export function enableDisabledTracks(header: Uint8Array): PatchedHeader {
	const empty: PatchedHeader = {
		bytes: header,
		regionEnd: 0,
		enabledTracks: 0,
		enabledTrackNumbers: [],
	};

	const segment = findElement(header, 0, header.length, ID.SEGMENT);
	if (!segment) return empty;

	const tracks = findElement(header, segment.start, segment.end, ID.TRACKS);
	if (!tracks) return empty;

	const patched = header.slice();
	const enabledTrackNumbers: number[] = [];
	let enabledTracks = 0;

	for (const entry of children(patched, tracks)) {
		if (entry.id !== ID.TRACK_ENTRY) continue;

		let trackNumber = 0;
		let shouldEnable = false;

		for (const field of children(patched, entry.range)) {
			if (field.id === ID.TRACK_NUMBER) {
				trackNumber = readUint(patched, field.range);
			} else if (field.id === ID.FLAG_ENABLED) {
				const size = field.range.end - field.range.start;
				if (size < 1) continue;
				let value = 0;
				for (let i = field.range.start; i < field.range.end; i++) value = value * 256 + patched[i];
				if (value === 0) {
					// The value is zero: set its last byte to one.
					patched[field.range.end - 1] = 1;
					shouldEnable = true;
					enabledTracks += 1;
				}
			}
		}

		if (shouldEnable) enabledTrackNumbers.push(trackNumber);
	}

	return {
		bytes: patched,
		regionEnd: tracks.end,
		enabledTracks,
		enabledTrackNumbers,
	};
}

/* ---------------------------------------------------------------- tracks */

function parseTrackEntry(data: Uint8Array, range: Range): MkvTrack | null {
	const track: MkvTrack = {
		number: 0,
		type: 'other',
		codecId: '',
		language: 'und',
		name: null,
		enabled: true,
		isDefault: false,
		forced: false,
		channels: null,
		sampleRate: null,
		width: null,
		height: null,
	};

	let trackType = 0;

	for (const child of children(data, range)) {
		switch (child.id) {
			case ID.TRACK_NUMBER:
				track.number = readUint(data, child.range);
				break;
			case ID.TRACK_TYPE:
				trackType = readUint(data, child.range);
				break;
			case ID.CODEC_ID:
				track.codecId = readString(data, child.range);
				break;
			case ID.LANGUAGE:
			case ID.LANGUAGE_IETF:
				track.language = readString(data, child.range) || 'und';
				break;
			case ID.NAME:
				track.name = readString(data, child.range) || null;
				break;
			case ID.FLAG_ENABLED:
				track.enabled = readUint(data, child.range) !== 0;
				break;
			case ID.FLAG_DEFAULT:
				track.isDefault = readUint(data, child.range) !== 0;
				break;
			case ID.FLAG_FORCED:
				track.forced = readUint(data, child.range) !== 0;
				break;
			case ID.VIDEO:
				for (const video of children(data, child.range)) {
					if (video.id === ID.PIXEL_WIDTH) track.width = readUint(data, video.range);
					if (video.id === ID.PIXEL_HEIGHT) track.height = readUint(data, video.range);
				}
				break;
			case ID.AUDIO:
				for (const audio of children(data, child.range)) {
					if (audio.id === ID.CHANNELS) track.channels = readUint(data, audio.range);
					if (audio.id === ID.SAMPLING_FREQUENCY) {
						track.sampleRate = Math.round(readFloat(data, audio.range));
					}
				}
				break;
			default:
				break;
		}
	}

	if (trackType === 1) track.type = 'video';
	else if (trackType === 2) track.type = 'audio';
	else if (trackType === 17) track.type = 'subtitle';

	return track;
}

function parseTracksElement(data: Uint8Array, range: Range): MkvTrack[] {
	const tracks: MkvTrack[] = [];
	for (const entry of children(data, range)) {
		if (entry.id !== ID.TRACK_ENTRY) continue;
		const track = parseTrackEntry(data, entry.range);
		if (track) tracks.push(track);
	}
	return tracks;
}

/* -------------------------------------------------------------- chapters */

interface RawChapter {
	title: string;
	language: string;
	intValue: number;
	floatValue: number;
	endIntValue: number | null;
	endFloatValue: number | null;
}

function parseChaptersElement(data: Uint8Array, range: Range): RawChapter[] {
	const chapters: RawChapter[] = [];

	for (const edition of children(data, range)) {
		if (edition.id !== ID.EDITION_ENTRY) continue;

		for (const atom of children(data, edition.range)) {
			if (atom.id !== ID.CHAPTER_ATOM) continue;

			let intValue = 0;
			let floatValue = 0;
			let endIntValue: number | null = null;
			let endFloatValue: number | null = null;
			let title = '';
			let language = 'und';

			for (const field of children(data, atom.range)) {
				if (field.id === ID.CHAPTER_TIME_START) {
					intValue = readUint(data, field.range);
					floatValue = readFloat(data, field.range);
				} else if (field.id === ID.CHAPTER_TIME_END) {
					endIntValue = readUint(data, field.range);
					endFloatValue = readFloat(data, field.range);
				} else if (field.id === ID.CHAPTER_DISPLAY) {
					for (const display of children(data, field.range)) {
						if (display.id === ID.CHAP_STRING) title = readString(data, display.range);
						if (display.id === ID.CHAP_LANGUAGE) language = readString(data, display.range);
					}
				}
			}

			chapters.push({
				title: title || `Chapter ${chapters.length + 1}`,
				language,
				intValue,
				floatValue,
				endIntValue,
				endFloatValue,
			});
		}
	}

	return chapters;
}

/**
 * Chapter times are stored either in nanoseconds (ffmpeg) or in timestamp-scale
 * units (the Matroska specification, as used by mkvmerge). The variant whose
 * resulting end time best matches the known media duration is picked.
 */
function pickTimeReader(
	chapters: RawChapter[],
	scale: number,
	duration: number | null,
): (raw: RawChapter) => number {
	const readers: Array<{ id: string; read: (raw: RawChapter) => number }> = [
		{ id: 'int-ns', read: (raw) => raw.intValue / 1e9 },
		{ id: 'int-scale', read: (raw) => (raw.intValue * scale) / 1e9 },
		{ id: 'float-ns', read: (raw) => raw.floatValue / 1e9 },
		{ id: 'float-scale', read: (raw) => (raw.floatValue * scale) / 1e9 },
	];

	let best = readers[0].read;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const reader of readers) {
		const values: number[] = [];

		for (const raw of chapters) {
			const value = reader.read(raw);
			if (!Number.isFinite(value) || value < 0) {
				values.length = 0;
				break;
			}
			values.push(value);

			if (reader.id.startsWith('int') && raw.endIntValue !== null) {
				const end = reader.read({ ...raw, intValue: raw.endIntValue });
				if (Number.isFinite(end) && end > 0) values.push(end);
			} else if (reader.id.startsWith('float') && raw.endFloatValue !== null) {
				const end = reader.read({ ...raw, floatValue: raw.endFloatValue });
				if (Number.isFinite(end) && end > 0) values.push(end);
			}
		}

		if (!values.length) continue;

		const max = Math.max(...values);
		const score =
			duration !== null && duration > 0
				? Math.abs(max - duration)
				: reader.id === 'int-ns'
					? 0
					: 1;

		if (score < bestScore - 1e-6) {
			bestScore = score;
			best = reader.read;
		}
	}

	return best;
}

/* ---------------------------------------------------------- subtitle cues */

const TEXT_CODECS = new Set(['s_text/utf8', 's_text/ass', 's_text/ssa', 's_text/webvtt', 's_text/ascii']);

/**
 * Parses the payload of a text subtitle block into cues.
 *
 * Matroska stores the cue time in the block header, so the payload usually
 * contains the plain text only. Some codecs (ASS) embed their own timings.
 */
function parseSubtitlePayload(
	codecId: string,
	payload: string,
	blockTime: number,
	blockDuration: number | null,
): SubtitleCue[] {
	if (!payload.trim()) return [];

	const codec = codecId.toLowerCase();

	if (codec === 's_text/ass' || codec === 's_text/ssa') {
		// The payload is a single ASS dialogue line.
		const dialogue = payload.trim();
		const separator = dialogue.indexOf(':');
		if (separator !== -1) {
			const fields = dialogue.slice(separator + 1).split(',');
			if (fields.length >= 10) {
				const start = parseAssTime(fields[1]);
				const end = parseAssTime(fields[2]);
				if (start !== null && end !== null) {
					const text = fields
						.slice(9)
						.join(',')
						.replace(/\{[^}]*\}/g, '')
						.replace(/\\N/gi, '\n');
					if (text.trim()) return [{ start, end, text }];
				}
			}
		}
	}

	// SRT / WebVTT style payloads may carry their own timestamps.
	const embedded = parseSubtitleText(payload);
	if (embedded.length) return embedded;

	// Plain text: the block header holds the timing.
	const text = payload
		.replace(/\r\n/g, '\n')
		.replace(/<\/?(?:i|b|u|s|font|r)(?:\s[^>]*)?>/gi, '')
		.trim();
	if (!text) return [];
	return [{ start: blockTime, end: blockTime + (blockDuration ?? 3), text }];
}

function parseAssTime(raw: string): number | null {
	const match = raw.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
	if (!match) return null;
	return (
		Number(match[1]) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(match[4].padEnd(3, '0')) / 1000
	);
}

interface SubtitleBlock {
	trackNumber: number;
	timestamp: number;
	duration: number | null;
	payload: Uint8Array;
}

/** Parses the blocks of a single cluster. */
function parseCluster(data: Uint8Array, clusterTimecode: number, scale: number): SubtitleBlock[] {
	const blocks: SubtitleBlock[] = [];

	for (const child of children(data, { start: 0, end: data.length })) {
		if (child.id === ID.SIMPLE_BLOCK) {
			const block = parseBlock(data, child.range, clusterTimecode, scale, null);
			if (block) blocks.push(block);
		} else if (child.id === ID.BLOCK_GROUP) {
			let blockData: Range | null = null;
			let duration: number | null = null;
			for (const field of children(data, child.range)) {
				if (field.id === ID.BLOCK) blockData = field.range;
				else if (field.id === ID.BLOCK_DURATION) duration = readUint(data, field.range);
			}
			if (blockData) {
				const block = parseBlock(data, blockData, clusterTimecode, scale, duration);
				if (block) blocks.push(block);
			}
		}
	}

	return blocks;
}

function parseBlock(
	data: Uint8Array,
	range: Range,
	clusterTimecode: number,
	scale: number,
	duration: number | null,
): SubtitleBlock | null {
	const trackVint = readVint(data, range.start);
	if (!trackVint) return null;

	let offset = range.start + trackVint.length;
	if (offset + 3 > range.end) return null;

	const relative = (data[offset] << 8) | data[offset + 1];
	offset += 2;
	const flags = data[offset];
	offset += 1;

	const lacing = (flags >> 1) & 0x03;
	if (lacing !== 0) return null; // Only un-laced blocks are handled

	const payload = data.subarray(offset, range.end);
	const timestamp = ((clusterTimecode + relative) * scale) / 1e9;

	return {
		trackNumber: trackVint.value,
		timestamp,
		duration: duration !== null ? (duration * scale) / 1e9 : null,
		payload,
	};
}

/* ----------------------------------------------------------------- scan */

/**
 * Scans a Matroska file for its tracks, chapters and embedded subtitle cues.
 *
 * @param source The file to scan.
 * @param options.durationHint Media duration, used to detect the chapter time unit.
 * @param options.onProgress Called with the number of bytes processed.
 */
export async function scanMatroska(
	source: ByteSource,
	options: {
		durationHint?: number | null;
		onProgress?: (loaded: number) => void;
		/** Called with the cues found so far, while the scan is still running. */
		onPartial?: (tracks: MkvSubtitleTrack[]) => void;
	} = {},
): Promise<MkvScanResult> {
	const empty: MkvScanResult = {
		tracks: [],
		subtitles: [],
		chapters: [],
		timestampScale: DEFAULT_TIMESTAMP_SCALE,
		isMatroska: false,
	};

	await source.ready?.();

	// The size may be unknown (e.g. a server that doesn't report it); the
	// scanner then works with a fixed window.
	const knownSize = Number.isFinite(source.size) ? source.size : Number.POSITIVE_INFINITY;
	if (knownSize < 8) return empty;

	const head = await readRange(source, 0, Math.min(knownSize, 16));
	if (head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) {
		return empty;
	}
	empty.isMatroska = true;

	// --- header region: tracks, chapters, timestamp scale -------------------
	const headerEnd = Math.min(knownSize, 8 * 1024 * 1024);
	let header = await readRange(source, 0, headerEnd);

	let segment: Range | null = findElement(header, 0, header.length, ID.SEGMENT);
	let tracks: MkvTrack[] = [];
	let chapters: Chapter[] = [];
	let timestampScale = DEFAULT_TIMESTAMP_SCALE;

	if (segment) {
		const info = findElement(header, segment.start, segment.end, ID.INFO);
		if (info) {
			for (const child of children(header, info)) {
				if (child.id === ID.TIMESTAMP_SCALE) {
					const scale = readUint(header, child.range);
					if (scale > 0) timestampScale = scale;
				}
			}
		}

		const tracksElement = findElement(header, segment.start, segment.end, ID.TRACKS);
		if (tracksElement) {
			tracks = parseTracksElement(header, tracksElement);
		}

		const chaptersElement = findElement(header, segment.start, segment.end, ID.CHAPTERS);
		if (chaptersElement) {
			const raw = parseChaptersElement(header, chaptersElement);
			if (raw.length) {
				const read = pickTimeReader(raw, timestampScale, options.durationHint ?? null);
				chapters = raw.map((item) => ({
					title: item.title,
					language: item.language,
					start: read(item),
					end:
						item.endIntValue !== null
							? read({ ...item, intValue: item.endIntValue, floatValue: item.endFloatValue ?? 0 })
							: null,
				}));
				chapters.sort((a, b) => a.start - b.start);
				for (let i = 0; i < chapters.length; i++) {
					const next = chapters[i + 1];
					if (chapters[i].end === null) chapters[i].end = next ? next.start : null;
				}
			}
		}
	}

	const subtitleTracks = tracks.filter(
		(track) => track.type === 'subtitle' && TEXT_CODECS.has(track.codecId.toLowerCase()),
	);

	const subtitles: MkvSubtitleTrack[] = [];

	if (subtitleTracks.length && segment) {
		const cueMap = new Map<number, SubtitleCue[]>();
		for (const track of subtitleTracks) cueMap.set(track.number, []);

		const segmentStart = segment.start;
		const segmentEnd = Math.min(segment.end, knownSize);

		const collect = (): MkvSubtitleTrack[] =>
			subtitleTracks.map((track) => {
				const cues = (cueMap.get(track.number) ?? []).sort((a, b) => a.start - b.start);
				// Cues without an explicit duration end when the next one starts.
				for (let i = 0; i < cues.length; i++) {
					const next = cues[i + 1];
					if (cues[i].end <= cues[i].start) {
						cues[i].end = next && next.start > cues[i].start ? next.start : cues[i].start + 3;
					}
				}
				return { ...track, cues };
			});

		let clusterCount = 0;

		for await (const element of iterateElements(source, segmentStart, segmentEnd)) {
			if (element.id !== ID.CLUSTER) continue;

			const clusterData = await readRange(source, element.dataStart, element.dataEnd);
			let clusterTimecode = 0;
			for (const child of children(clusterData, { start: 0, end: clusterData.length })) {
				if (child.id === ID.TIMECODE) {
					clusterTimecode = readUint(clusterData, child.range);
					break;
				}
			}

			for (const block of parseCluster(clusterData, clusterTimecode, timestampScale)) {
				const cues = cueMap.get(block.trackNumber);
				if (!cues) continue;
				const text = new TextDecoder('utf-8').decode(block.payload);
				const parsed = parseSubtitlePayload(
					codecOf(subtitleTracks, block.trackNumber),
					text,
					block.timestamp,
					block.duration,
				);
				for (const cue of parsed) cues.push(cue);
			}

			options.onProgress?.(element.dataEnd);

			// Report what has been found so far, so that the cues show up while
			// the rest of the file is still being scanned.
			clusterCount += 1;
			if (clusterCount % 5 === 0) options.onPartial?.(collect());
		}

		subtitles.push(...collect());
	}

	return {
		tracks,
		subtitles,
		chapters,
		timestampScale,
		isMatroska: true,
	};
}

function codecOf(tracks: MkvTrack[], trackNumber: number): string {
	return tracks.find((track) => track.number === trackNumber)?.codecId ?? '';
}

/**
 * Iterates over the top-level elements of a region, reading the file in
 * windows. Elements that cross a window boundary are yielded with their full
 * extent; the caller reads their contents separately.
 */
async function* iterateElements(
	source: ByteSource,
	start: number,
	end: number,
): AsyncGenerator<{ id: number; dataStart: number; dataEnd: number }> {
	let offset = start;

	while (offset < end) {
		const windowEnd = Math.min(end, offset + WINDOW_SIZE);
		const data = await readRange(source, offset, windowEnd);
		let position = 0;

		while (position < data.length) {
			const header = readHeader(data, position);
			if (!header) {
				position = data.length;
				break;
			}

			const dataStart = position + header.idLength + header.sizeLength;
			const dataEnd = header.unknownSize ? windowEnd : dataStart + header.size;

			yield { id: header.id, dataStart: offset + dataStart, dataEnd: offset + dataEnd };


			if (dataEnd > windowEnd) {
				// The element continues past the window: resume after it.
				position = dataEnd;
				break;
			}

			position = dataEnd;
		}

		if (position <= 0) break;
		offset += position;
	}
}

/**
 * Reads chapters from an MKV file. The header region is scanned first; if no
 * chapters are found there, the tail of the file is scanned as well (some
 * muxers write the chapters element at the end).
 */
export async function readMkvChapters(file: ByteSource | Blob, durationHint: number | null = null): Promise<Chapter[]> {
	const source = file instanceof Blob ? blobByteSource(file) : file;
	const result = await scanMatroska(source, { durationHint });
	return result.chapters;
}
