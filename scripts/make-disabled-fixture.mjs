/**
 * Builds `test/fixtures/disabled-tracks.mkv` from the multi-audio fixture by
 * flagging its second audio track as disabled (`FlagEnabled = 0`) — the way
 * many dual-audio releases mark their alternate tracks. A demuxer that honours
 * the flag hides that track, which is exactly what the player has to undo.
 *
 * Run with: node scripts/make-disabled-fixture.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', 'test', 'fixtures', 'multi-audio.mkv');
const outFile = resolve(here, '..', 'test', 'fixtures', 'disabled-tracks.mkv');

const data = new Uint8Array(await readFile(source));

/* ------------------------------------------------------------- parsing */

function readId(offset) {
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

function readSize(offset) {
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
	let allOnes = value === mask - 1;
	for (let i = 1; i < length; i++) {
		value = value * 256 + data[offset + i];
		if (data[offset + i] !== 0xff) allOnes = false;
	}
	return { value, length, unknown: allOnes };
}

/** Reads an element header and returns its extent. */
function elementAt(offset, limit = data.length) {
	const id = readId(offset);
	const size = readSize(offset + id.length);
	const dataStart = offset + id.length + size.length;
	return {
		id: id.value,
		idLength: id.length,
		size: size.value,
		sizeLength: size.length,
		offset,
		dataStart,
		dataEnd: size.unknown ? limit : dataStart + size.value,
	};
}

/* ------------------------------------------------------------- writing */

function encodeId(value) {
	const bytes = [];
	let v = value;
	do {
		bytes.unshift(v & 0xff);
		v = Math.floor(v / 256);
	} while (v > 0);
	return Uint8Array.from(bytes);
}

function encodeSize(value) {
	if (value < 0x7f) return Uint8Array.from([0x80 | value]);
	if (value < 0x3fff) return Uint8Array.from([0x40 | (value >> 8), value & 0xff]);
	if (value < 0x1fffff) {
		return Uint8Array.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
	}
	return Uint8Array.from([
		0x10 | ((value >> 24) & 0xff),
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff,
	]);
}

function concat(...parts) {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function encodeElement(elementId, payload) {
	return concat(encodeId(elementId), encodeSize(payload.length), payload);
}

/* --------------------------------------------------------- the rewrite */

const ebmlHeader = data.subarray(0, elementAt(0).dataEnd);
const segment = elementAt(ebmlHeader.length);

const children = [];
{
	let offset = segment.dataStart;
	while (offset < segment.dataEnd) {
		const child = elementAt(offset);
		children.push(child);
		offset = child.dataEnd;
	}
}

const FLAG_ENABLED = 0xb9;
const flagEnabled = encodeElement(FLAG_ENABLED, Uint8Array.from([0]));

const rebuilt = children.map((child) => {
	if (child.id !== 0x1654ae6b) {
		return data.subarray(child.offset, child.dataEnd);
	}

	// Rebuild the tracks element, flagging the second track as disabled.
	const entries = [];
	let offset = child.dataStart;
	while (offset < child.dataEnd) {
		const entry = elementAt(offset);
		entries.push(entry);
		offset = entry.dataEnd;
	}

	const payloads = entries.map((entry) => {
		const body = data.subarray(entry.dataStart, entry.dataEnd);

		// Find the track number.
		let number = 0;
		let inner = entry.dataStart;
		while (inner < entry.dataEnd) {
			const field = elementAt(inner);
			if (field.id === 0xd7) {
				let value = 0;
				for (let i = field.dataStart; i < field.dataEnd; i++) value = value * 256 + data[i];
				number = value;
			}
			inner = field.dataEnd;
		}

		return number === 2
			? encodeElement(entry.id, concat(body, flagEnabled))
			: encodeElement(entry.id, body);
	});

	return encodeElement(0x1654ae6b, concat(...payloads));
});

const newSegment = encodeElement(0x18538067, concat(...rebuilt));
const out = concat(ebmlHeader, newSegment);

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, out);
console.log(`Wrote ${outFile} (${out.length} bytes) with track 2 flagged as disabled`);
