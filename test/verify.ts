/**
 * Node-side verification for the parts of the player that do not need WebCodecs:
 * demuxing behaviour, the MKV chapter parser and the subtitle parsers.
 *
 * Run with: node --experimental-strip-types test/verify.ts
 */
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { readMkvChapters } from '../src/mkv.ts';
import { parseSubtitleText } from '../src/subtitles.ts';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		failures++;
		console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
	}
}

async function inspect(path: string): Promise<Input> {
	const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
	return input;
}

console.log('\n== multi-audio.mkv ==');
{
	const input = await inspect('test/fixtures/multi-audio.mkv');
	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();

	check('one video track', videoTracks.length === 1, `got ${videoTracks.length}`);
	check('three audio tracks', audioTracks.length === 3, `got ${audioTracks.length}`);

	const languages: string[] = [];
	for (const track of audioTracks) {
		languages.push(await track.getLanguageCode());
	}
	check('languages are eng/jpn/spa', languages.join(',') === 'eng,jpn,spa', languages.join(','));

	const codecs: string[] = [];
	const channels: number[] = [];
	const rates: number[] = [];
	for (const track of audioTracks) {
		codecs.push((await track.getCodec()) ?? 'null');
		channels.push(await track.getNumberOfChannels());
		rates.push(await track.getSampleRate());
	}
	check('all AAC', codecs.every((codec) => codec === 'aac'), codecs.join(','));
	check('channel layouts 2/2/6', channels.join(',') === '2,2,6', channels.join(','));
	check('mixed sample rates', rates.includes(44100) && rates.includes(48000), rates.join(','));

	const names: string[] = [];
	for (const track of audioTracks) {
		names.push((await track.getName()) ?? '');
	}
	check('track names preserved', names[0] === 'English 5.1', names.join('|'));

	const duration = await input.getDurationFromMetadata([...videoTracks, ...audioTracks]);
	check('duration ~8s', duration !== null && Math.abs(duration - 8) < 1.5, String(duration));

	const firstTimestamp = await input.getFirstTimestamp([...videoTracks, ...audioTracks]);
	check('first timestamp ~0', Math.abs(firstTimestamp) < 0.5, String(firstTimestamp));
	input.dispose();
}

console.log('\n== ac3-5.1.mkv ==');
{
	const input = await inspect('test/fixtures/ac3-5.1.mkv');
	const audioTracks = await input.getAudioTracks();
	check('one audio track', audioTracks.length === 1, `got ${audioTracks.length}`);
	const codec = await audioTracks[0].getCodec();
	check('codec is ac3', codec === 'ac3', String(codec));
	const channels = await audioTracks[0].getNumberOfChannels();
	check('6 channels', channels === 6, String(channels));
	input.dispose();
}

console.log('\n== chapters.mkv ==');
{
	const chapters = await readMkvChapters(
		new Blob([await (await import('node:fs/promises')).readFile('test/fixtures/chapters.mkv')]),
		8,
	);
	check('two chapters found', chapters.length === 2, `got ${chapters.length}`);
	if (chapters.length === 2) {
		check('first chapter title', chapters[0].title === 'Opening', chapters[0].title);
		check('first chapter start 0s', Math.abs(chapters[0].start) < 0.01, String(chapters[0].start));
		check('second chapter start 3s', Math.abs(chapters[1].start - 3) < 0.01, String(chapters[1].start));
		check('second chapter title', chapters[1].title === 'Main story', chapters[1].title);
		check('chapter end inferred', Math.abs((chapters[0].end ?? -1) - 3) < 0.01, String(chapters[0].end));
	}
}

console.log('\n== subtitle parsers ==');
{
	const srt = `1\n00:00:01,000 --> 00:00:04,000\nHello there\nSecond line\n\n2\n00:00:05,500 --> 00:00:07,000\nBye\n`;
	const srtCues = parseSubtitleText(srt);
	check('srt cue count', srtCues.length === 2, `got ${srtCues.length}`);
	check('srt start', Math.abs(srtCues[0].start - 1) < 0.001, String(srtCues[0].start));
	check('srt end', Math.abs(srtCues[0].end - 4) < 0.001, String(srtCues[0].end));
	check('srt multiline', srtCues[0].text.includes('Second line'), srtCues[0].text);

	const vtt = `WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nVtt cue\n`;
	const vttCues = parseSubtitleText(vtt);
	check('vtt cue count', vttCues.length === 1, `got ${vttCues.length}`);
	check('vtt start', Math.abs(vttCues[0].start - 2) < 0.001, String(vttCues[0].start));

	const ass = `[Script Info]\nTitle: test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\b1}Ass{\\b0} cue\\Nline two\n`;
	const assCues = parseSubtitleText(ass);
	check('ass cue count', assCues.length === 1, `got ${assCues.length}`);
	check('ass text cleaned', assCues[0]?.text === 'Ass cue\nline two', JSON.stringify(assCues[0]?.text));
	check('ass start', Math.abs((assCues[0]?.start ?? 0) - 1.5) < 0.001, String(assCues[0]?.start));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
