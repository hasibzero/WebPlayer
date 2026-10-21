/** Formatting helpers shared across the UI. */

export function formatTime(seconds: number, showMillis = false): string {
	if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = Math.floor(seconds % 60);
	const base =
		hours > 0
			? `${hours}:${minutes.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`
			: `${minutes}:${rest.toString().padStart(2, '0')}`;
	if (!showMillis) return base;
	const millis = Math.floor((seconds % 1) * 1000);
	return `${base}.${millis.toString().padStart(3, '0')}`;
}

export function formatBytes(bytes: number): string {
	if (!bytes) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatBitrate(bitsPerSecond: number | null): string {
	if (!bitsPerSecond) return '—';
	if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
	return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

const LANGUAGE_NAMES: Record<string, string> = {
	und: 'Undetermined',
	eng: 'English',
	jpn: 'Japanese',
	ger: 'German',
	deu: 'German',
	fre: 'French',
	fra: 'French',
	spa: 'Spanish',
	ita: 'Italian',
	rus: 'Russian',
	kor: 'Korean',
	chi: 'Chinese',
	zho: 'Chinese',
	ara: 'Arabic',
	hin: 'Hindi',
	por: 'Portuguese',
	nld: 'Dutch',
	dut: 'Dutch',
	swe: 'Swedish',
	pol: 'Polish',
	tur: 'Turkish',
	cze: 'Czech',
	ces: 'Czech',
	gre: 'Greek',
	ell: 'Greek',
	heb: 'Hebrew',
	tha: 'Thai',
	vie: 'Vietnamese',
	ind: 'Indonesian',
	msa: 'Malay',
	ron: 'Romanian',
	hun: 'Hungarian',
	ukr: 'Ukrainian',
	cze_ISO: 'Czech',
	fin: 'Finnish',
	ces_ISO: 'Czech',
	nor: 'Norwegian',
	dan: 'Danish',
	bul: 'Bulgarian',
	hrv: 'Croatian',
	srp: 'Serbian',
	slk: 'Slovak',
	slv: 'Slovenian',
	est: 'Estonian',
	lav: 'Latvian',
	lit: 'Lithuanian',
	cat: 'Catalan',
	baq: 'Basque',
	eus: 'Basque',
	glg: 'Galician',
	ice: 'Icelandic',
	isl: 'Icelandic',
	alb: 'Albanian',
	sqi: 'Albanian',
	mkd: 'Macedonian',
	bel: 'Belarusian',
	uzb: 'Uzbek',
	kaz: 'Kazakh',
	geo: 'Georgian',
	arm: 'Armenian',
	aze: 'Azerbaijani',
	fil: 'Filipino',
	tam: 'Tamil',
	tel: 'Telugu',
	ben: 'Bengali',
	urd: 'Urdu',
	mar: 'Marathi',
	kan: 'Kannada',
	mal: 'Malayalam',
	guj: 'Gujarati',
	pun: 'Punjabi',
	nep: 'Nepali',
	sin: 'Sinhala',
	mya: 'Burmese',
	khm: 'Khmer',
	lao: 'Lao',
	amh: 'Amharic',
};

export function languageName(code: string | null | undefined): string {
	if (!code) return 'Undetermined';
	const normalized = code.toLowerCase().replace(/_/g, '-');
	const base = normalized.split('-')[0];
	return LANGUAGE_NAMES[base] ?? LANGUAGE_NAMES[normalized] ?? code.toUpperCase();
}

const CODEC_NAMES: Record<string, string> = {
	aac: 'AAC',
	opus: 'Opus',
	mp3: 'MP3',
	vorbis: 'Vorbis',
	flac: 'FLAC',
	ac3: 'AC-3',
	eac3: 'E-AC-3',
	dts: 'DTS',
	avc: 'H.264 / AVC',
	h264: 'H.264 / AVC',
	hevc: 'H.265 / HEVC',
	h265: 'H.265 / HEVC',
	vp9: 'VP9',
	vp8: 'VP8',
	av1: 'AV1',
	prores: 'Apple ProRes',
	pcm: 'PCM',
};

export function codecName(codec: string | null | undefined): string {
	if (!codec) return 'Unknown';
	return CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase();
}
