/**
 * Reads the subtitle cues of a Matroska file while the video plays.
 *
 * Scanning a multi-gigabyte file for subtitle blocks from the beginning takes
 * minutes. This scanner instead follows the playhead: it reads a small window
 * ahead of the current position, so the cues for what you are watching show up
 * almost immediately, and it jumps to a new position when you seek.
 *
 * The Matroska cluster timecodes are used to map between media time and byte
 * position, which makes seeking cheap: the file is probed at a few offsets
 * until the right cluster is found.
 */

import type { SubtitleCue } from './subtitles.ts';
import { parseSubtitleText } from './subtitles.ts';

export interface ScanTrack {
	/** Track number as stored in the container. */
	number: number;
	codecId: string;
}

export interface SubtitleScannerOptions {
	source: {
		size: number;
		slice(start: number, end: number): Promise<Uint8Array>;
	};
	tracks: ScanTrack[];
	/** Nanoseconds per Matroska timecode tick. */
	timestampScale: number;
	/** Called whenever new cues have been found. */
	onUpdate: (tracks: Array<{ number: number; codecId: string; cues: SubtitleCue[] }>) => void;
}

/** How far ahead of the playhead the scanner reads, in seconds. */
const LOOKAHEAD = 90;
/** Size of a read window, in bytes. */
const WINDOW_SIZE = 4 * 1024 * 1024;

const ID = {
	SEGMENT: 0x18538067,
	CLUSTER: 0x1f43b675,
	TIMECODE: 0xe7,
	SIMPLE_BLOCK: 0xa3,
	BLOCK_GROUP: 0xa0,
	BLOCK: 0xa1,
	BLOCK_DURATION: 0x9b,
};

interface Range {
	start: number;
	end: number;
}

function readId(data: Uint8Array, offset: number): { value: number; length: number } | null {
	const first = data[offset];
	if (first === undefined || first === 0) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 4 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 4) return null;
	let value = 0;
	for (let i = 0; i < length; i++) value = value * 256 + data[offset + i];
	return { value, length };
}

function readSize(data: Uint8Array, offset: number): { value: number; length: number } | null {
	const first = data[offset];
	if (first === undefined) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 8 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 8) return null;
	let value = first & (mask - 1);
	for (let i = 1; i < length; i++) value = value * 256 + data[offset + i];
	return { value, length };
}

function readUint(data: Uint8Array, range: Range): number {
	let value = 0;
	for (let i = range.start; i < range.end && i < data.length; i++) value = value * 256 + data[i];
	return value;
}

/** Reads an EBML variable-length integer (marker bits are not part of the value). */
function readVint(data: Uint8Array, offset: number): { value: number; length: number } | null {
	const first = data[offset];
	if (first === undefined) return null;
	let length = 1;
	let mask = 0x80;
	while (length <= 8 && !(first & mask)) {
		mask >>= 1;
		length++;
	}
	if (length > 8) return null;
	let value = first & (mask - 1);
	for (let i = 1; i < length; i++) value = value * 256 + data[offset + i];
	return { value, length };
}

/** Iterates the direct children of a byte range. */
function* children(data: Uint8Array, range: Range): Generator<{ id: number; range: Range }> {
	let offset = range.start;
	while (offset < range.end) {
		const id = readId(data, offset);
		if (!id) return;
		const size = readSize(data, offset + id.length);
		if (!size) return;
		const dataStart = offset + id.length + size.length;
		const dataEnd = Math.min(range.end, dataStart + size.value);
		yield { id: id.value, range: { start: dataStart, end: dataEnd } };
		if (dataEnd <= offset) return;
		offset = dataEnd;
	}
}

/** Parses the text payload of a subtitle block. */
function parsePayload(codecId: string, payload: string, blockTime: number, duration: number | null): SubtitleCue[] {
	if (!payload.trim()) return [];

	const codec = codecId.toLowerCase();
	if (codec === 's_text/ass' || codec === 's_text/ssa') {
		const separator = payload.indexOf(':');
		if (separator !== -1) {
			const fields = payload.slice(separator + 1).split(',');
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

	const embedded = parseSubtitleText(payload);
	if (embedded.length) return embedded;

	const text = payload
		.replace(/\r\n/g, '\n')
		.replace(/<\/?(?:i|b|u|s|font|r)(?:\s[^>]*)?>/gi, '')
		.trim();
	if (!text) return [];
	return [{ start: blockTime, end: blockTime + (duration ?? 3), text }];
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

interface Block {
	trackNumber: number;
	timestamp: number;
	duration: number | null;
	payload: Uint8Array;
}

interface ScannedCue {
	trackNumber: number;
	cue: SubtitleCue;
}

function parseBlock(
	data: Uint8Array,
	range: Range,
	clusterTimecode: number,
	scale: number,
	duration: number | null,
): Block | null {
	const trackVint = readVint(data, range.start);
	if (!trackVint) return null;

	let offset = range.start + trackVint.length;
	if (offset + 3 > range.end) return null;

	const relative = (data[offset] << 8) | data[offset + 1];
	offset += 2;
	const flags = data[offset];
	offset += 1;

	if (((flags >> 1) & 0x03) !== 0) return null; // laced blocks are not used for subtitles

	return {
		trackNumber: trackVint.value,
		timestamp: ((clusterTimecode + relative) * scale) / 1e9,
		duration: duration !== null ? (duration * scale) / 1e9 : null,
		payload: data.subarray(offset, range.end),
	};
}

export class SubtitleScanner {
	private readonly source: SubtitleScannerOptions['source'];
	private readonly tracks: Map<number, string>;
	private readonly scale: number;
	private readonly onUpdate: SubtitleScannerOptions['onUpdate'];

	/** Found cues, per track number and start time. */
	private readonly cues = new Map<number, Map<number, SubtitleCue>>();
	/** Known cluster positions, sorted by their timecode. */
	private clusters: Array<{ offset: number; time: number }> = [];
	private cursor = 0;
	private insideSegment = false;
	private lastTime = 0;
	private targetTime = 0;
	private scanning = false;
	private stopped = false;
	private dirty = false;

	constructor(options: SubtitleScannerOptions) {
		this.source = options.source;
		this.scale = options.timestampScale;
		this.onUpdate = options.onUpdate;
		this.tracks = new Map(options.tracks.map((track) => [track.number, track.codecId]));
	}

	/** The cues found so far, per track. */
	get currentCues(): Array<{ number: number; codecId: string; cues: SubtitleCue[] }> {
		return Array.from(this.tracks.entries()).map(([number, codecId]) => ({
			number,
			codecId,
			cues: Array.from(this.cues.get(number)?.values() ?? []).sort((a, b) => a.start - b.start),
		}));
	}

	/** Asks the scanner to cover up to the given media time. */
	request(time: number): void {
		const target = time + LOOKAHEAD;
		if (target <= this.targetTime && !this.dirty) return;
		this.targetTime = target;
		this.dirty = true;
		void this.pump();
	}

	/** Moves the scanner to another position in the file. */
	async seek(time: number): Promise<void> {
		this.dirty = false;
		this.targetTime = time + LOOKAHEAD;
		try {
			this.cursor = await this.locate(time);
			if (Number.isFinite(time)) this.lastTime = time;
		} catch (error) {
			console.warn('Could not locate the subtitles at that position', error);
			this.cursor = 0;
		}
		void this.pump();
	}

	stop(): void {
		this.stopped = true;
	}

	/* ------------------------------------------------------------ scanning */

	private async pump(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;

		try {
			while (!this.stopped && (this.dirty || this.lastTime < this.targetTime)) {
				this.dirty = false;
				const advanced = await this.scanNextChunk();
				if (advanced <= 0) break;
			}
		} catch (error) {
			console.warn('Scanning for subtitles failed', error);
		} finally {
			this.scanning = false;
		}
	}

	/**
	 * Reads the next window of the file and extracts its subtitle blocks.
	 *
	 * @returns The number of bytes that were consumed.
	 */
	private async scanNextChunk(): Promise<number> {
		const size = this.source.size;
		if (!Number.isFinite(size) || this.cursor >= size) return 0;

		const end = Math.min(size, this.cursor + WINDOW_SIZE);
		const data = await this.source.slice(this.cursor, end);
		if (!data.length) return 0;

		let found = false;
		let position = 0;

		while (position < data.length) {
			const id = readId(data, position);
			if (!id) break;
			const sizeField = readSize(data, position + id.length);
			if (!sizeField) break;

			const dataStart = position + id.length + sizeField.length;
			const dataEnd = dataStart + sizeField.value;

			if (!this.insideSegment && id.value === ID.SEGMENT) {
				// The clusters live inside the segment, so descend into it.
				this.insideSegment = true;
				const segmentEnd = Math.min(data.length, dataEnd);
				let child = dataStart;

				while (child < segmentEnd) {
					const childId = readId(data, child);
					if (!childId) break;
					const childSize = readSize(data, child + childId.length);
					if (!childSize) break;

					const childStart = child + childId.length + childSize.length;
					const childEnd = childStart + childSize.value;

					if (childEnd > segmentEnd) {
						// The element continues past the window: resume after it.
						position = childEnd;
						break;
					}

					if (childId.value === ID.CLUSTER) {
						const cluster = await this.readCluster(
							this.cursor + childStart,
							this.cursor + childEnd,
						);
						if (cluster) {
							found = true;
							this.addCluster(this.cursor + childStart, cluster);
						}
					}

					child = childEnd;
					position = childEnd;
				}

				break;
			}

			if (id.value === ID.CLUSTER) {
				const cluster = await this.readCluster(this.cursor + dataStart, this.cursor + dataEnd);
				if (cluster) {
					found = true;
					this.addCluster(this.cursor + dataStart, cluster);
				}
			}

			if (dataEnd > data.length) {
				// The element continues past the window: resume after it.
				position = dataEnd;
				break;
			}
			position = dataEnd;
		}

		if (position <= 0) return 0;
		this.cursor += position;
		if (found) this.publish();
		return position;
	}

	/** Stores the cues of a cluster. */
	private addCluster(offset: number, cluster: { time: number; cues: ScannedCue[] }): void {
		if (!Number.isFinite(cluster.time)) return;
		this.clusters.push({ offset, time: cluster.time });
		this.lastTime = Math.max(this.lastTime, cluster.time);
		for (const entry of cluster.cues) {
			let track = this.cues.get(entry.trackNumber);
			if (!track) {
				track = new Map();
				this.cues.set(entry.trackNumber, track);
			}
			track.set(Math.round(entry.cue.start * 1000), entry.cue);
		}
	}

	/** Reads a single cluster and returns its subtitle cues. */
	private async readCluster(
		start: number,
		end: number,
	): Promise<{ time: number; cues: ScannedCue[] } | null> {
		let data: Uint8Array;
		try {
			data = await this.source.slice(start, end);
		} catch {
			return null;
		}
		if (!data.length) return null;

		let clusterTimecode = 0;
		for (const child of children(data, { start: 0, end: data.length })) {
			if (child.id === ID.TIMECODE) {
				clusterTimecode = readUint(data, child.range);
				break;
			}
		}

		const cues: ScannedCue[] = [];
		const decoder = new TextDecoder('utf-8');

		for (const child of children(data, { start: 0, end: data.length })) {
			if (child.id === ID.SIMPLE_BLOCK) {
				this.collectBlock(data, child.range, clusterTimecode, decoder, cues);
			} else if (child.id === ID.BLOCK_GROUP) {
				let blockRange: Range | null = null;
				let duration: number | null = null;
				for (const field of children(data, child.range)) {
					if (field.id === ID.BLOCK) blockRange = field.range;
					else if (field.id === ID.BLOCK_DURATION) duration = readUint(data, field.range);
				}
				if (blockRange) this.collectBlock(data, blockRange, clusterTimecode, decoder, cues, duration);
			}
		}

		return { time: (clusterTimecode * this.scale) / 1e9, cues };
	}

	private collectBlock(
		data: Uint8Array,
		range: Range,
		clusterTimecode: number,
		decoder: TextDecoder,
		cues: ScannedCue[],
		duration: number | null = null,
	): void {
		const block = parseBlock(data, range, clusterTimecode, this.scale, duration);
		if (!block) return;
		const codecId = this.tracks.get(block.trackNumber);
		if (!codecId) return;
		const text = decoder.decode(block.payload);
		for (const cue of parsePayload(codecId, text, block.timestamp, block.duration)) {
			cues.push({ trackNumber: block.trackNumber, cue });
		}
	}

	private publish(): void {
		this.onUpdate(this.currentCues);
	}

	/* -------------------------------------------------------------- seeking */

	/**
	 * Finds the byte offset of the cluster that contains the given media time by
	 * probing the file at a few positions.
	 */
	private async locate(time: number): Promise<number> {
		// Known clusters are the best guess.
		for (const cluster of this.clusters) {
			if (cluster.time >= time) return cluster.offset;
		}

		const size = this.source.size;
		let low = 0;
		let high = size;
		let best = 0;

		while (high - low > WINDOW_SIZE / 2) {
			const middle = Math.floor((low + high) / 2);
			const probe = await this.probeTime(middle);
			if (probe === null) {
				low = middle;
				continue;
			}
			if (probe > time) {
				high = middle;
				best = middle;
			} else {
				low = middle;
			}
		}

		// Read the window at the best position and pick the first cluster that is
		// not in the future.
		const window = await this.source.slice(best, Math.min(size, best + WINDOW_SIZE));
		for (const child of children(window, { start: 0, end: window.length })) {
			if (child.id !== ID.CLUSTER) continue;
			const cluster = await this.readCluster(best + child.range.start, best + child.range.end);
			if (!cluster) continue;
			if (cluster.time >= time) return best + child.range.start;
		}

		return best;
	}

	/** Reads the timecode of the cluster closest to the given offset. */
	private async probeTime(offset: number): Promise<number | null> {
		const size = this.source.size;
		const end = Math.min(size, offset + 256 * 1024);
		let data: Uint8Array;
		try {
			data = await this.source.slice(offset, end);
		} catch {
			return null;
		}
		if (!data.length) return null;

		for (const child of children(data, { start: 0, end: data.length })) {
			if (child.id !== ID.CLUSTER) continue;
			const cluster = await this.readCluster(offset + child.range.start, offset + child.range.end);
			if (cluster) return cluster.time;
		}
		return null;
	}
}
