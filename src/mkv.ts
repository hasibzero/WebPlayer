/**
 * Minimal Matroska (MKV) parser used to extract chapter information, which the
 * MediaBunny demuxer does not expose. Only the small subset of EBML needed to
 * locate and read the `Chapters` element is implemented.
 */

export interface Chapter {
	title: string;
	start: number;
	end: number | null;
	language: string;
}

const ID = {
	SEGMENT: 0x18538067,
	CHAPTERS: 0x1043a770,
	EDITION_ENTRY: 0x45b9,
	CHAPTER_ATOM: 0xb6,
	CHAPTER_TIME_START: 0x91,
	CHAPTER_TIME_END: 0x92,
	CHAPTER_DISPLAY: 0x80,
	CHAP_STRING: 0x85,
	CHAP_LANGUAGE: 0x437c,
	INFO: 0x1549a966,
	TIMESTAMP_SCALE: 0x2ad7b1,
} as const;

/** Elements we are willing to descend into while searching. */
const CONTAINERS = new Set<number>([ID.SEGMENT, ID.EDITION_ENTRY, ID.CHAPTER_ATOM, ID.CHAPTER_DISPLAY]);

/** Default Matroska timestamp scale: 1 ms. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

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
	for (let i = 0; i < length; i++) {
		value = value * 256 + data[offset + i];
	}
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

function readUint(data: Uint8Array, range: Range): number {
	let value = 0;
	for (let i = range.start; i < range.end && i < data.length; i++) {
		value = value * 256 + data[i];
	}
	return value;
}

function readFloat(data: Uint8Array, range: Range): number {
	const size = range.end - range.start;
	if (size === 4) {
		const view = new DataView(data.buffer, data.byteOffset + range.start, 4);
		return view.getFloat32(0, false);
	}
	if (size === 8) {
		const view = new DataView(data.buffer, data.byteOffset + range.start, 8);
		return view.getFloat64(0, false);
	}
	return Number.NaN;
}

function readString(data: Uint8Array, range: Range): string {
	return new TextDecoder('utf-8').decode(data.subarray(range.start, range.end)).replace(/\0+$/, '');
}

/** Finds the first element with the given id, descending into known containers. */
function findElement(data: Uint8Array, start: number, end: number, target: number): Range | null {
	let offset = start;

	while (offset < end) {
		const header = readHeader(data, offset);
		if (!header) return null;

		const dataStart = offset + header.idLength + header.sizeLength;
		const dataEnd = header.unknownSize ? end : Math.min(end, dataStart + header.size);

		if (header.id === target) {
			return { start: dataStart, end: dataEnd };
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

/** Iterates the direct children of a range. */
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
						if (display.id === ID.CHAP_STRING) {
							title = readString(data, display.range);
						} else if (display.id === ID.CHAP_LANGUAGE) {
							language = readString(data, display.range);
						}
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

/**
 * Reads chapters from an MKV file. The header region is scanned first; if no
 * chapters are found there, the tail of the file is scanned as well (some
 * muxers write the chapters element at the end).
 *
 * @param file The media file to scan.
 * @param durationHint Media duration in seconds, used to detect the time unit.
 */
export async function readMkvChapters(file: Blob, durationHint: number | null = null): Promise<Chapter[]> {
	const size = file.size;
	if (size < 1024) return [];

	const windowSize = Math.min(size, 8 * 1024 * 1024);
	const regions: Array<{ start: number; end: number }> = [{ start: 0, end: windowSize }];

	if (size > windowSize * 1.5) {
		regions.push({ start: size - windowSize, end: size });
	}

	for (const region of regions) {
		const buffer = await file.slice(region.start, region.end).arrayBuffer();
		const data = new Uint8Array(buffer);

		const found = findElement(data, 0, data.length, ID.CHAPTERS);
		if (!found) continue;

		const raw = parseChaptersElement(data, found);
		if (!raw.length) continue;

		const scale = readTimestampScale(data);
		const read = pickTimeReader(raw, scale, durationHint);

		const chapters: Chapter[] = raw.map((item) => ({
			title: item.title,
			language: item.language,
			start: read(item),
			end: item.endIntValue !== null ? read({ ...item, intValue: item.endIntValue, floatValue: item.endFloatValue ?? 0 }) : null,
		}));

		chapters.sort((a, b) => a.start - b.start);
		for (let i = 0; i < chapters.length; i++) {
			const next = chapters[i + 1];
			if (chapters[i].end === null) chapters[i].end = next ? next.start : null;
		}

		return chapters;
	}

	return [];
}

/** Reads the Matroska timestamp scale (in nanoseconds per tick) from the info element. */
function readTimestampScale(data: Uint8Array): number {
	const info = findElement(data, 0, data.length, ID.INFO);
	if (!info) return DEFAULT_TIMESTAMP_SCALE;

	for (const child of children(data, info)) {
		if (child.id === ID.TIMESTAMP_SCALE) {
			const scale = readUint(data, child.range);
			if (scale > 0) return scale;
		}
	}

	return DEFAULT_TIMESTAMP_SCALE;
}
