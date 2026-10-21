/** Sidecar subtitle parsing (SRT / WebVTT / ASS-SSA) plus the on-screen renderer. */

export interface SubtitleCue {
	start: number;
	end: number;
	text: string;
}

export interface SubtitleTrack {
	id: string;
	name: string;
	language: string;
	cues: SubtitleCue[];
	/** Where the track came from. */
	source?: 'embedded' | 'sidecar';
}

/* ------------------------------------------------------------- timestamp */

function parseTimestamp(raw: string): number | null {
	const match = raw
		.trim()
		.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$|^(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
	if (!match) return null;

	const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match;
	if (h1 !== undefined) {
		return Number(h1) * 3600 + Number(m1) * 60 + Number(s1) + Number(ms1.padEnd(3, '0')) / 1000;
	}
	return Number(h2) * 3600 + Number(m2) * 60 + Number(s2) + Number(ms2.padEnd(3, '0')) / 1000;
}

function parseAssTimestamp(raw: string): number | null {
	const match = raw.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
	if (!match) return null;
	return (
		Number(match[1]) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(match[4].padEnd(3, '0')) / 1000
	);
}

/* ------------------------------------------------------------------ SRT */

function parseSrt(text: string): SubtitleCue[] {
	const cues: SubtitleCue[] = [];
	const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);

	for (const block of blocks) {
		const lines = block.split('\n').filter((line) => line.trim().length > 0);
		if (lines.length === 0) continue;

		let index = 0;
		if (/^\d+$/.test(lines[0].trim()) && lines.length > 1) index = 1;

		const timingLine = lines[index];
		if (!timingLine || !timingLine.includes('-->')) continue;

		const [rawStart, rawRest] = timingLine.split('-->');
		const rawEnd = rawRest.trim().split(/\s+/)[0];
		const start = parseTimestamp(rawStart);
		const end = parseTimestamp(rawEnd);
		if (start === null || end === null) continue;

		const body = lines.slice(index + 1).join('\n');
		if (!body.trim()) continue;
		cues.push({ start, end, text: body });
	}

	return cues;
}

/* ------------------------------------------------------------------ VTT */

function parseVtt(text: string): SubtitleCue[] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const cues: SubtitleCue[] = [];

	for (const block of normalized.split(/\n{2,}/)) {
		const lines = block.split('\n').filter((line) => line.trim().length > 0);
		if (lines.length === 0) continue;

		let index = 0;
		if (/^WEBVTT/i.test(lines[0]) && lines.length > 1) index = 1;
		if (lines[index] && /^\d+$/.test(lines[index].trim()) && lines.length > index + 2) index++;

		const timingLine = lines[index];
		if (!timingLine || !timingLine.includes('-->')) continue;

		const [rawStart, rawRest] = timingLine.split('-->');
		const rawEnd = rawRest.trim().split(/\s+/)[0];
		const start = parseTimestamp(rawStart);
		const end = parseTimestamp(rawEnd);
		if (start === null || end === null) continue;

		const body = lines.slice(index + 1).join('\n');
		if (!body.trim()) continue;
		cues.push({ start, end, text: body.replace(/<[^>]+>/g, '') });
	}

	return cues;
}

/* ------------------------------------------------------------------ ASS */

function parseAss(text: string): SubtitleCue[] {
	const cues: SubtitleCue[] = [];
	let inEvents = false;

	for (const rawLine of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;

		if (/^\[/.test(line)) {
			inEvents = /^\[events\]/i.test(line);
			continue;
		}
		if (!inEvents) continue;

		const separator = line.indexOf(':');
		if (separator === -1) continue;
		const kind = line.slice(0, separator).trim().toLowerCase();
		if (kind !== 'dialogue') continue;

		const fields = line.slice(separator + 1).split(',');
		if (fields.length < 10) continue;

		const start = parseAssTimestamp(fields[1]);
		const end = parseAssTimestamp(fields[2]);
		if (start === null || end === null) continue;

		const body = fields.slice(9).join(',').trim();
		if (!body) continue;

		cues.push({
			start,
			end,
			text: body
				.replace(/\{[^}]*\}/g, '')
				.replace(/\\N/gi, '\n')
				.replace(/\\n/gi, '\n')
				.replace(/\\h/gi, ' '),
		});
	}

	return cues;
}

/* --------------------------------------------------------------- public */

/** Parses a subtitle file, detecting the format from its content. */
export function parseSubtitleText(text: string): SubtitleCue[] {
	if (/^\s*\[Script Info\]/i.test(text) || /^\s*\[Events\]/im.test(text)) {
		const ass = parseAss(text);
		if (ass.length) return ass;
	}
	if (/^\s*WEBVTT/i.test(text)) {
		const vtt = parseVtt(text);
		if (vtt.length) return vtt;
	}
	const srt = parseSrt(text);
	if (srt.length) return srt;
	const vtt = parseVtt(text);
	if (vtt.length) return vtt;
	return parseAss(text);
}

/** Renders the active cue on top of the video. */
export class SubtitleRenderer {
	private cues: SubtitleCue[] = [];
	private activeId = -1;
	private readonly element: HTMLElement;

	constructor(element: HTMLElement) {
		this.element = element;
	}

	setTrack(cues: SubtitleCue[]): void {
		this.cues = cues;
		this.activeId = -1;
		this.element.textContent = '';
		this.element.replaceChildren();
	}

	clear(): void {
		this.setTrack([]);
	}

	update(time: number): void {
		let found = -1;
		for (let i = 0; i < this.cues.length; i++) {
			const cue = this.cues[i];
			if (time >= cue.start && time <= cue.end) {
				found = i;
				break;
			}
			if (cue.start > time) break;
		}

		if (found === this.activeId) return;
		this.activeId = found;

		if (found === -1) {
			this.element.replaceChildren();
			return;
		}

		const node = document.createElement('div');
		node.className = 'cue';
		node.textContent = this.cues[found].text;
		this.element.replaceChildren(node);
	}
}
