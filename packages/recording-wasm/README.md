# @stll/recording-wasm

The desktop's recording reader (`apps/desktop/src-tauri/crates/recording`) compiled to WebAssembly, so the API reads a stored recording the way the desktop reads one from disk: the format from its first bytes, its first audio track decoded to one channel, cut into pieces at pauses (15 to 55 seconds) and handed out as 16 kHz mono PCM WAV, one transcription request each. The same crate cuts the same pieces wherever a recording is transcribed.

Formats: WAV, AIFF, FLAC, MP3, AAC, M4A, the sound of MP4 and QuickTime video, Ogg (Vorbis and Opus), WebM and Matroska, CAF. WMA and AMR, which the desktop decodes through the operating system, are refused as `unsupported`; DSS and DS2 dictaphone files as `dictaphone`.

```ts
import {
  initRecordingReader,
  openRecording,
  RECORDING_WASM_URL,
} from "@stll/recording-wasm";

initRecordingReader(
  await WebAssembly.compile(await Bun.file(RECORDING_WASM_URL).arrayBuffer()),
);
const opened = openRecording({ size, chunks, extension: "m4a" });
```

`openRecording` writes the chunks straight into WebAssembly memory, so the recording is held once. Pieces are decoded when `next()` asks for them; `close()` frees the recording. Run it off the main thread: decoding one piece takes tens of milliseconds.

## Building

`generated/` holds the committed bindings. They are built on x86_64 Linux with the Rust version in `rust-toolchain.toml` and wasm-bindgen 0.2.130 (`bun run build:wasm`); elsewhere use `bun run build:wasm:container` (Docker) or the `recording-wasm` directory of the `scan-engine-wasm` artifact the `scan-engine-wasm-drift` CI job uploads when the committed bindings are out of date.
