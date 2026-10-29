import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  TRANSCRIPTION_DURATION_TOLERANCE_MS,
} from "@stll/api-contract/transcription";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MAX_CHUNKS = 4096;
const MAX_DURATION_MS =
  MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 + TRANSCRIPTION_DURATION_TOLERANCE_MS;
const M4A_BRANDS = new Set([
  "M4A ",
  "M4B ",
  "isom",
  "iso2",
  "mp41",
  "mp42",
  "qt  ",
]);

export const createUnreadableAudioError = (): HandlerError<422> =>
  new HandlerError({
    status: 422,
    code: "audio_unreadable",
    message: "The audio duration cannot be read safely.",
    hint: "Record a new audio chunk in PCM WAV or M4A format.",
  });

const tooLong = (): HandlerError<422> =>
  new HandlerError({
    status: 422,
    code: "audio_too_long",
    message: "The audio chunk exceeds the supported duration.",
    hint: "Split the recording into shorter audio chunks.",
  });

const tagAt = (bytes: Uint8Array, offset: number) =>
  new TextDecoder("ascii").decode(bytes.subarray(offset, offset + 4));
const boundedDuration = (
  durationMs: number,
): Result<number, HandlerError<422>> => {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return Result.err(createUnreadableAudioError());
  }
  return durationMs > MAX_DURATION_MS
    ? Result.err(tooLong())
    : Result.ok(durationMs);
};

const readWavDuration = (
  bytes: Uint8Array,
): Result<number, HandlerError<422>> => {
  if (
    bytes.length < 12 ||
    tagAt(bytes, 0) !== "RIFF" ||
    tagAt(bytes, 8) !== "WAVE"
  ) {
    return Result.err(createUnreadableAudioError());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    return Result.err(createUnreadableAudioError());
  }
  let format: { byteRate: number; blockAlign: number } | undefined;
  let dataSize: number | undefined;
  let chunks = 0;
  let offset = 12;
  while (offset < bytes.length) {
    if (++chunks > MAX_CHUNKS || bytes.length - offset < 8) {
      return Result.err(createUnreadableAudioError());
    }
    const kind = tagAt(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    const next = payload + size + (size % 2);
    if (next > bytes.length) {
      return Result.err(createUnreadableAudioError());
    }
    if (kind === "fmt ") {
      if (
        format !== undefined ||
        (size !== 16 && size !== 18) ||
        (size === 18 && view.getUint16(payload + 16, true) !== 0)
      ) {
        return Result.err(createUnreadableAudioError());
      }
      // WAVEFORMATEX defines byteRate = sampleRate * blockAlign for PCM/float.
      const encoding = view.getUint16(payload, true);
      const channels = view.getUint16(payload + 2, true);
      const sampleRate = view.getUint32(payload + 4, true);
      const byteRate = view.getUint32(payload + 8, true);
      const blockAlign = view.getUint16(payload + 12, true);
      const bits = view.getUint16(payload + 14, true);
      const supported =
        encoding === 1
          ? [8, 16, 24, 32].includes(bits)
          : encoding === 3 && [32, 64].includes(bits);
      if (
        !supported ||
        channels === 0 ||
        sampleRate === 0 ||
        byteRate === 0 ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== sampleRate * blockAlign
      ) {
        return Result.err(createUnreadableAudioError());
      }
      format = { byteRate, blockAlign };
    }
    if (kind === "data") {
      if (dataSize !== undefined || size === 0) {
        return Result.err(createUnreadableAudioError());
      }
      dataSize = size;
    }
    offset = next;
  }
  if (
    format === undefined ||
    dataSize === undefined ||
    dataSize % format.blockAlign !== 0
  ) {
    return Result.err(createUnreadableAudioError());
  }
  return boundedDuration(Math.ceil((dataSize * 1000) / format.byteRate));
};

type Container = {
  start: number;
  end: number;
  kind: "root" | "moov" | "trak" | "mdia";
};
type Mp4Box = { kind: string; payload: number; end: number };

type ReadBoxOptions = {
  bytes: Uint8Array;
  start: number;
  end: number;
};

const readBox = ({
  bytes,
  start,
  end,
}: ReadBoxOptions): Result<Mp4Box, HandlerError<422>> => {
  if (end - start < 8) {
    return Result.err(createUnreadableAudioError());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(start);
  const kind = tagAt(bytes, start + 4);
  if (size === 0) {
    return Result.ok({ kind, payload: start + 8, end });
  }
  if (size !== 1) {
    return size < 8 || size > end - start
      ? Result.err(createUnreadableAudioError())
      : Result.ok({ kind, payload: start + 8, end: start + size });
  }
  if (end - start < 16) {
    return Result.err(createUnreadableAudioError());
  }
  const largeSize = view.getBigUint64(start + 8);
  if (largeSize < 16n || largeSize > BigInt(end - start)) {
    return Result.err(createUnreadableAudioError());
  }
  const parsed = parseIntegerToken(largeSize.toString(), { sign: "unsigned" });
  return parsed.isErr()
    ? Result.err(createUnreadableAudioError())
    : Result.ok({ kind, payload: start + 16, end: start + parsed.value });
};

const readMp4DurationField = (
  bytes: Uint8Array,
  { kind, payload, end }: Mp4Box,
): Result<number, HandlerError<422>> => {
  const version = bytes.at(payload);
  if (version !== 0 && version !== 1) {
    return Result.err(createUnreadableAudioError());
  }
  const minimumLength = (kind === "mvhd" ? 100 : 24) + (version === 1 ? 12 : 0);
  if (end - payload < minimumLength) {
    return Result.err(createUnreadableAudioError());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(payload) !== (version === 0 ? 0 : 0x1_00_00_00)) {
    return Result.err(createUnreadableAudioError());
  }
  // ISO BMFF version 1 widens creation/modification times and duration to 64 bits.
  const scaleOffset = payload + (version === 0 ? 12 : 20);
  const scale = BigInt(view.getUint32(scaleOffset));
  const ticks =
    version === 0
      ? BigInt(view.getUint32(scaleOffset + 4))
      : view.getBigUint64(scaleOffset + 4);
  if (
    scale === 0n ||
    ticks === 0n ||
    ticks === (version === 0 ? 0xff_ff_ff_ffn : 0xff_ff_ff_ff_ff_ff_ff_ffn)
  ) {
    return Result.err(createUnreadableAudioError());
  }
  const millis = (ticks * 1000n + scale - 1n) / scale;
  if (millis > BigInt(MAX_DURATION_MS)) {
    return Result.err(tooLong());
  }
  const parsed = parseIntegerToken(millis.toString(), { sign: "unsigned" });
  return parsed.isErr()
    ? Result.err(createUnreadableAudioError())
    : boundedDuration(parsed.value);
};

const validFileType = (bytes: Uint8Array, box: Mp4Box) =>
  box.end - box.payload >= 8 &&
  (box.end - box.payload - 8) % 4 === 0 &&
  M4A_BRANDS.has(tagAt(bytes, box.payload));

type Mp4ScanState = {
  containers: Container[];
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMedia: boolean;
  maximum: number;
  chunks: number;
};

type ReadM4aContainerOptions = {
  bytes: Uint8Array;
  container: Container;
  state: Mp4ScanState;
};

const readM4aContainer = ({
  bytes,
  container,
  state,
}: ReadM4aContainerOptions): Result<void, HandlerError<422>> => {
  let offset = container.start;
  let durationFields = 0;
  let mediaContainers = 0;
  while (offset < container.end) {
    if (++state.chunks > MAX_CHUNKS) {
      return Result.err(createUnreadableAudioError());
    }
    const parsed = readBox({ bytes, start: offset, end: container.end });
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }
    const box = parsed.value;
    if (box.kind === "moof" || box.kind === "mvex") {
      return Result.err(createUnreadableAudioError());
    }
    if (box.kind === "ftyp") {
      if (
        container.kind !== "root" ||
        state.hasFtyp ||
        !validFileType(bytes, box)
      ) {
        return Result.err(createUnreadableAudioError());
      }
      state.hasFtyp = true;
    }
    if (
      box.kind === "mdat" &&
      container.kind === "root" &&
      box.end > box.payload
    ) {
      state.hasMedia = true;
    }
    if (box.kind === "moov" || box.kind === "trak" || box.kind === "mdia") {
      const expectedParent = {
        moov: "root",
        trak: "moov",
        mdia: "trak",
      } as const;
      if (
        container.kind !== expectedParent[box.kind] ||
        box.payload === box.end ||
        (box.kind === "moov" && state.hasMoov)
      ) {
        return Result.err(createUnreadableAudioError());
      }
      if (box.kind === "moov") {
        state.hasMoov = true;
      }
      if (box.kind === "mdia") {
        mediaContainers++;
      }
      state.containers.push({
        start: box.payload,
        end: box.end,
        kind: box.kind,
      });
    }
    if (box.kind === "mvhd" || box.kind === "mdhd") {
      if (
        container.kind !== (box.kind === "mvhd" ? "moov" : "mdia") ||
        ++durationFields > 1
      ) {
        return Result.err(createUnreadableAudioError());
      }
      const duration = readMp4DurationField(bytes, box);
      if (duration.isErr()) {
        return Result.err(duration.error);
      }
      state.maximum = Math.max(state.maximum, duration.value);
    }
    offset = box.end;
  }
  const complete = {
    root: true,
    moov: true,
    trak: mediaContainers === 1,
    mdia: durationFields === 1,
  } as const satisfies Record<Container["kind"], boolean>;
  if (!complete[container.kind]) {
    return Result.err(createUnreadableAudioError());
  }
  return Result.ok(undefined);
};

const readM4aDuration = (
  bytes: Uint8Array,
): Result<number, HandlerError<422>> => {
  const state: Mp4ScanState = {
    containers: [{ start: 0, end: bytes.length, kind: "root" }],
    hasFtyp: false,
    hasMoov: false,
    hasMedia: false,
    maximum: 0,
    chunks: 0,
  };
  for (
    let container = state.containers.pop();
    container !== undefined;
    container = state.containers.pop()
  ) {
    const read = readM4aContainer({ bytes, container, state });
    if (read.isErr()) {
      return Result.err(read.error);
    }
  }
  return !state.hasFtyp || !state.hasMoov || !state.hasMedia
    ? Result.err(createUnreadableAudioError())
    : boundedDuration(state.maximum);
};

export const readAdmissibleAudioDuration = (
  bytes: Uint8Array,
  format: "wav" | "m4a",
): Result<number, HandlerError<422>> => {
  if (bytes.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return Result.err(createUnreadableAudioError());
  }
  return format === "wav" ? readWavDuration(bytes) : readM4aDuration(bytes);
};
