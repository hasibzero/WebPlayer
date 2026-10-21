# MultiAudio Player

A web-based video player for **local files** with first-class support for **multiple audio
tracks** — the thing browsers normally refuse to do with MKV. Built on
[MediaBunny](https://mediabunny.dev) (pure-TypeScript demuxing + WebCodecs decoding) and
the Web Audio API.

Everything runs in the browser: files are read straight from disk and **never uploaded**.

![player](test/screenshots/02-playing.png)

## Features

- **Any local file** — MKV, MP4/MOV, WebM, AVI, MPEG-TS, OGG, FLAC, MP3, AAC … The container is
  demuxed in pure JavaScript, so Matroska files that browsers refuse to play (e.g. H.264/AAC
  inside MKV) work just fine.
- **Multi-audio** — every audio track is listed with its language, codec, channel layout and
  sample rate. Enable several at once to **mix** them (original + commentary, stereo + 5.1, …),
  each with its own volume fader.
- **Multiple video tracks** — pick between alternate angles/encodings of the same file.
- **Embedded subtitles** — Matroska subtitle tracks (`S_TEXT/UTF8`, `S_TEXT/ASS`, `S_TEXT/WEBVTT`)
  are read directly from the container, because the demuxer does not expose them. They show up in
  the Subtitles section and can be toggled like any other track.
- **Chapters** — MKV/Matroska chapters are parsed and shown in the side panel (click to jump).
- **Subtitles** — load sidecar `.srt`, `.vtt` or `.ass/.ssa` files (drag them onto the window
  or use *Load subtitle file*); they are rendered on top of the video.
- **Player extras** — seek bar, playback speed (0.25×–4×), volume/mute, picture-in-picture,
  fullscreen, screenshots, playlist (next/previous), keyboard shortcuts, media info panel.
- **Extra decoders on demand** — AC-3/E-AC-3, DTS and Apple ProRes are supported through
  optional WASM decoders that are only downloaded when a file actually needs them.

## Requirements

A browser with **WebCodecs** support:

| Browser | Minimum version |
| --- | --- |
| Chrome / Edge | 94 |
| Firefox | 130 |
| Safari | 16.4 |

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:5173/> and drop a file onto the window.

Production build and local preview:

```bash
npm run build
npm run preview      # serves ./dist on http://localhost:4173/
```

## Browser extension

The `extension/` folder is a Manifest V3 extension that adds an **"Open in MultiAudio Player"**
option for direct video links.

- **Left-click** a link to a video file (`.mkv`, `.mp4`, `.webm`, `.avi`, `.ts`, `.mov`, …) on any
  page and a small menu appears with *Open in MultiAudio Player*, *Open normally* and *Copy link*.
- **Right-click** a link (or a `<video>`/`<audio>` element) and pick *Open in MultiAudio Player*
  from the browser context menu.
- The extension toolbar button opens a popup where you can paste any video URL, or open the
  player for a local file.
- Because the player page runs as an extension page, it **bypasses CORS**: links from servers
  that do not allow cross-origin requests can still be played, and cookies are sent along.

### Installing it

```bash
npm run build:extension   # builds the player into extension/dist
```

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder of this project.
4. Pin the extension, then left-click any direct video link on a page.

> Google Chrome 137+ blocks `--load-extension` on the command line, so unpacked extensions must be
> loaded through the extensions page. Edge is unaffected.

To ship it as a zip instead:

```bash
npm run pack:extension   # -> multiaudio-player-extension.zip
```

### Servers without range support

Some file servers ignore `Range` headers and always answer with `200 OK` and the whole body.
MediaBunny can only stream such a response sequentially, which normally breaks seeking (the
cache moves forward and older data is discarded). The player handles this itself:

1. It probes the server once (`Range: bytes=0-1`).
2. If the server answers with **206 Partial Content**, a second probe near the end of the file
   confirms that the offsets are really honoured — some hosts echo a correct `Content-Range`
   header but always send the first bytes, which produces a broken file with missing tracks.
3. Depending on the result:
   - ranges work → the file is streamed normally, only the needed byte ranges are fetched,
   - no range support and the file is ≤ 512 MiB → the file is cached completely in memory
     (`maxCacheSize: Infinity`),
   - no range support, unreliable ranges, or a large/unknown file → the file is **downloaded
     first** with a progress bar and then played from the blob.

Either way seeking keeps working, all audio tracks are found, and the player tells you what it
did. The probe deliberately bypasses the HTTP cache (`cache: 'no-store'`) so that discarding its
body cannot corrupt the entry used for the actual download.

If a remote file still shows fewer tracks than expected, the **Media info** section shows what the
container itself declares (*In container*) next to what the player could read, and offers
*Re-download & re-scan*, which fetches the file completely and parses it again. When the container
lists more audio tracks than were detected, the player downloads the file a second time on its own
and re-parses it, because that almost always means the server delivered the file incompletely.

## Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `Space` / `K` | Play / pause | `M` | Mute |
| `←` / `→` | Seek ∓5 s | `F` | Fullscreen |
| `↑` / `↓` | Volume | `P` | Picture-in-picture |
| `0`–`9` | Seek to 0–90 % | `S` | Screenshot |
| `[` / `]` | Slower / faster | `C` | Toggle subtitles |
| `Home` / `End` | Start / end | | |

## How it works

```
File (Blob)
   │  no upload, no server round-trip
   ▼
MediaBunny Input ──► demuxes the container (Matroska/MP4/WebM/…)
   │
   ├─ Video track ──► CanvasSink ──► WebCodecs VideoDecoder ──► <canvas>
   │
   └─ Audio tracks ─► AudioBufferSink ─► WebCodecs AudioDecoder ─► AudioBuffer
                          │                                            │
                          └──────── per-track GainNode ─► master Gain ─► speakers
```

- Video is decoded with **WebCodecs** and painted into a canvas, so no container/codec
  combination is off-limits as long as the browser can decode the elementary stream.
- Every enabled audio track gets its own decoder chain and `GainNode`. All of them are
  scheduled against the same `AudioContext` clock, which keeps them sample-accurate in sync
  with each other and with the video — that is what makes mixing multiple tracks possible.
- Chapters are read by a small dedicated Matroska/EBML parser (`src/mkv.ts`) because the
  demuxer does not expose them.

## Project layout

```
index.html            markup / layout
src/main.ts           app bootstrap, file handling, playlist, ?url= support
src/player.ts         playback engine (video sink, audio mixer, clock, transport)
src/ui.ts             controls, track panels, keyboard shortcuts
src/mkv.ts            Matroska chapter parser
src/subtitles.ts      SRT / VTT / ASS parsing + subtitle renderer
src/format.ts         formatting helpers
extension/            the browser extension (manifest, service worker, content script)
test/verify.ts        Node tests: demuxing, chapter parser, subtitle parsers
test/browser-check.ts end-to-end test in headless Chrome
test/extension-check.ts end-to-end test for the extension
```

## Tests

```bash
npm test              # Node: demuxing, chapters, subtitle parsing
npm run test:browser  # headless Chrome: playback, mixing, seeking, chapters
npm run test:extension # headless Edge: link menu, context menu, remote playback
```

The browser tests need Chrome (resp. Edge) installed and the dev server running
(`npm run dev`); they use the fixtures in `test/fixtures`. The extension test loads
`extension/` unpacked and serves a video **without** CORS headers to prove the extension
bypasses the restriction.

## License

MIT
