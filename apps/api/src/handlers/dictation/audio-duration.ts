import { panic, Result } from "better-result";

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

const MP4_CONTAINER_KINDS = ["moov", "trak", "mdia", "minf", "stbl"] as const;
type Mp4ContainerKind = (typeof MP4_CONTAINER_KINDS)[number];
type Mp4Duration = { durationMs: number; scale: bigint; ticks: bigint };
type SampleTiming = { ticks: bigint; sampleCount: bigint; entries: number };
type TrackMetadata = {
  header?: Mp4Duration;
  handler?: "soun" | "vide";
  timing?: SampleTiming;
  sampleCount?: bigint;
};
type Container = { start: number; end: number } & (
  | { kind: "root" | "moov" | "trak" }
  | { kind: "mdia" | "minf" | "stbl"; track: TrackMetadata }
);
const isMp4ContainerKind = (kind: string): kind is Mp4ContainerKind =>
  MP4_CONTAINER_KINDS.some((candidate) => candidate === kind);
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

type DurationTicksOptions = { ticks: bigint; scale: bigint };
const durationFromTicks = ({
  ticks,
  scale,
}: DurationTicksOptions): Result<number, HandlerError<422>> => {
  const millis = (ticks * 1000n + scale - 1n) / scale;
  if (millis > BigInt(MAX_DURATION_MS)) {
    return Result.err(tooLong());
  }
  const parsed = parseIntegerToken(millis.toString(), { sign: "unsigned" });
  return parsed.isErr()
    ? Result.err(createUnreadableAudioError())
    : boundedDuration(parsed.value);
};

const readMp4DurationField = (
  bytes: Uint8Array,
  { kind, payload, end }: Mp4Box,
): Result<Mp4Duration, HandlerError<422>> => {
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
  return durationFromTicks({ ticks, scale }).map((durationMs) => ({
    durationMs,
    ticks,
    scale,
  }));
};

type ReadSampleTimingOptions = {
  bytes: Uint8Array;
  box: Mp4Box;
  remainingEntries: number;
};
const readSampleTiming = ({
  bytes,
  box: { payload, end },
  remainingEntries,
}: ReadSampleTimingOptions): Result<SampleTiming, HandlerError<422>> => {
  if (end - payload < 8) {
    return Result.err(createUnreadableAudioError());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getUint32(payload + 4);
  if (
    view.getUint32(payload) !== 0 ||
    entries === 0 ||
    entries > remainingEntries ||
    end - payload !== 8 + entries * 8
  ) {
    return Result.err(createUnreadableAudioError());
  }
  let ticks = 0n;
  let sampleCount = 0n;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  // STTS entries contain sample count and decode delta in the MDHD timescale.
  // https://developer.apple.com/documentation/quicktime-file-format/time-to-sample_atom
  for (let index = 0; index < entries; index++) {
    const offset = payload + 8 + index * 8;
    const count = BigInt(view.getUint32(offset));
    const delta = BigInt(view.getUint32(offset + 4));
    if (count === 0n || delta === 0n) {
      return Result.err(createUnreadableAudioError());
    }
    ticks += count * delta;
    sampleCount += count;
    if (ticks > maximum || sampleCount > maximum) {
      return Result.err(createUnreadableAudioError());
    }
  }
  return Result.ok({ ticks, sampleCount, entries });
};

type ReadSampleSizesOptions = {
  bytes: Uint8Array;
  box: Mp4Box;
  mediaBytes: number;
};
const readSampleSizes = ({
  bytes,
  box: { kind, payload, end },
  mediaBytes,
}: ReadSampleSizesOptions): Result<bigint, HandlerError<422>> => {
  if (end - payload < 12) {
    return Result.err(createUnreadableAudioError());
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(payload + 8);
  if (view.getUint32(payload) !== 0 || count === 0 || count > mediaBytes) {
    return Result.err(createUnreadableAudioError());
  }
  if (kind === "stsz") {
    const size = view.getUint32(payload + 4);
    const expectedBytes = size === 0 ? 12 + count * 4 : 12;
    if (
      end - payload !== expectedBytes ||
      BigInt(size) * BigInt(count) > BigInt(mediaBytes)
    ) {
      return Result.err(createUnreadableAudioError());
    }
    return Result.ok(BigInt(count));
  }
  const fieldSize = view.getUint32(payload + 4);
  if (
    ![4, 8, 16].includes(fieldSize) ||
    end - payload !== 12 + Math.ceil((count * fieldSize) / 8)
  ) {
    return Result.err(createUnreadableAudioError());
  }
  return Result.ok(BigInt(count));
};

const validFileType = (bytes: Uint8Array, box: Mp4Box) =>
  box.end - box.payload >= 8 &&
  (box.end - box.payload - 8) % 4 === 0 &&
  M4A_BRANDS.has(tagAt(bytes, box.payload));
const readHandler = (
  bytes: Uint8Array,
  { payload, end }: Mp4Box,
): Result<"soun" | "vide", HandlerError<422>> => {
  if (
    end - payload < 24 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      payload,
    ) !== 0
  ) {
    return Result.err(createUnreadableAudioError());
  }
  const handler = tagAt(bytes, payload + 8);
  return handler === "soun" || handler === "vide"
    ? Result.ok(handler)
    : Result.err(createUnreadableAudioError());
};

type Mp4ScanState = {
  containers: Container[];
  tracks: TrackMetadata[];
  hasFtyp: boolean;
  hasMoov: boolean;
  mediaBytes: number;
  maximum: number;
  chunks: number;
  sampleEntries: number;
};
type Mp4ReadOptions = {
  bytes: Uint8Array;
  container: Container;
  state: Mp4ScanState;
};
type ReadMp4LeafOptions = Mp4ReadOptions & { box: Mp4Box };
const readMp4Leaf = ({
  bytes,
  container,
  state,
  box,
}: ReadMp4LeafOptions): Result<void, HandlerError<422>> => {
  switch (box.kind) {
    case "ftyp":
      if (
        container.kind !== "root" ||
        state.hasFtyp ||
        !validFileType(bytes, box)
      ) {
        return Result.err(createUnreadableAudioError());
      }
      state.hasFtyp = true;
      return Result.ok(undefined);
    case "mdat":
      if (container.kind !== "root" || box.end === box.payload) {
        return Result.err(createUnreadableAudioError());
      }
      state.mediaBytes += box.end - box.payload;
      return Result.ok(undefined);
    case "mvhd": {
      if (container.kind !== "moov") {
        return Result.err(createUnreadableAudioError());
      }
      const duration = readMp4DurationField(bytes, box);
      if (duration.isErr()) {
        return Result.err(duration.error);
      }
      state.maximum = Math.max(state.maximum, duration.value.durationMs);
      return Result.ok(undefined);
    }
    case "mdhd": {
      if (container.kind !== "mdia" || container.track.header !== undefined) {
        return Result.err(createUnreadableAudioError());
      }
      const duration = readMp4DurationField(bytes, box);
      if (duration.isErr()) {
        return Result.err(duration.error);
      }
      container.track.header = duration.value;
      state.maximum = Math.max(state.maximum, duration.value.durationMs);
      return Result.ok(undefined);
    }
    case "hdlr": {
      if (container.kind !== "mdia" || container.track.handler !== undefined) {
        return Result.err(createUnreadableAudioError());
      }
      const handler = readHandler(bytes, box);
      if (handler.isErr()) {
        return Result.err(handler.error);
      }
      container.track.handler = handler.value;
      return Result.ok(undefined);
    }
    case "stts": {
      if (container.kind !== "stbl" || container.track.timing !== undefined) {
        return Result.err(createUnreadableAudioError());
      }
      const timing = readSampleTiming({
        bytes,
        box,
        remainingEntries: MAX_CHUNKS - state.sampleEntries,
      });
      if (timing.isErr()) {
        return Result.err(timing.error);
      }
      container.track.timing = timing.value;
      state.sampleEntries += timing.value.entries;
      return Result.ok(undefined);
    }
    case "stsz":
    case "stz2": {
      if (
        container.kind !== "stbl" ||
        container.track.sampleCount !== undefined
      ) {
        return Result.err(createUnreadableAudioError());
      }
      const count = readSampleSizes({
        bytes,
        box,
        mediaBytes: state.mediaBytes,
      });
      if (count.isErr()) {
        return Result.err(count.error);
      }
      container.track.sampleCount = count.value;
      return Result.ok(undefined);
    }
    case "moof":
    case "mvex":
      return Result.err(createUnreadableAudioError());
    default:
      return Result.ok(undefined);
  }
};

type QueueContainerOptions = Mp4ReadOptions & {
  box: Mp4Box;
  kind: Mp4ContainerKind;
};
const queueContainer = ({
  container,
  state,
  box,
  kind,
}: QueueContainerOptions): Result<void, HandlerError<422>> => {
  if (box.payload === box.end) {
    return Result.err(createUnreadableAudioError());
  }
  const span = { start: box.payload, end: box.end };
  switch (kind) {
    case "moov":
      if (container.kind !== "root" || state.hasMoov) {
        return Result.err(createUnreadableAudioError());
      }
      state.hasMoov = true;
      state.containers.push({ ...span, kind });
      return Result.ok(undefined);
    case "trak":
      if (container.kind !== "moov") {
        return Result.err(createUnreadableAudioError());
      }
      state.containers.push({ ...span, kind });
      return Result.ok(undefined);
    case "mdia": {
      if (container.kind !== "trak") {
        return Result.err(createUnreadableAudioError());
      }
      const track: TrackMetadata = {};
      state.tracks.push(track);
      state.containers.push({ ...span, kind, track });
      return Result.ok(undefined);
    }
    case "minf":
      if (container.kind !== "mdia") {
        return Result.err(createUnreadableAudioError());
      }
      state.containers.push({ ...span, kind, track: container.track });
      return Result.ok(undefined);
    case "stbl":
      if (container.kind !== "minf") {
        return Result.err(createUnreadableAudioError());
      }
      state.containers.push({ ...span, kind, track: container.track });
      return Result.ok(undefined);
    default:
      kind satisfies never;
      return panic("Unhandled M4A container kind");
  }
};

const readM4aContainer = ({
  bytes,
  container,
  state,
}: Mp4ReadOptions): Result<void, HandlerError<422>> => {
  let offset = container.start;
  let childContainers = 0;
  let movieHeaders = 0;
  while (offset < container.end) {
    if (++state.chunks > MAX_CHUNKS) {
      return Result.err(createUnreadableAudioError());
    }
    const parsed = readBox({ bytes, start: offset, end: container.end });
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }
    const box = parsed.value;
    if (box.kind === "mvhd" && ++movieHeaders > 1) {
      return Result.err(createUnreadableAudioError());
    }
    const read = isMp4ContainerKind(box.kind)
      ? queueContainer({ bytes, container, state, box, kind: box.kind })
      : readMp4Leaf({ bytes, container, state, box });
    if (read.isErr()) {
      return Result.err(read.error);
    }
    if (isMp4ContainerKind(box.kind)) {
      childContainers++;
    }
    offset = box.end;
  }
  const complete = {
    root: true,
    moov: true,
    trak: childContainers === 1,
    mdia: childContainers <= 1,
    minf: childContainers === 1,
    stbl: childContainers === 0,
  } as const satisfies Record<Container["kind"], boolean>;
  return complete[container.kind]
    ? Result.ok(undefined)
    : Result.err(createUnreadableAudioError());
};

const readAudioTrackDuration = (
  tracks: readonly TrackMetadata[],
): Result<number, HandlerError<422>> => {
  let audio: TrackMetadata | undefined;
  for (const track of tracks) {
    if (track.header === undefined || track.handler === undefined) {
      return Result.err(createUnreadableAudioError());
    }
    if (track.handler !== "soun") {
      continue;
    }
    if (audio !== undefined) {
      return Result.err(createUnreadableAudioError());
    }
    audio = track;
  }
  if (
    audio?.header === undefined ||
    audio.timing === undefined ||
    audio.sampleCount === undefined
  ) {
    return Result.err(createUnreadableAudioError());
  }
  const { ticks, scale } = audio.header;
  const duration = durationFromTicks({ ticks: audio.timing.ticks, scale });
  if (duration.isErr()) {
    return Result.err(duration.error);
  }
  const difference =
    ticks >= audio.timing.ticks
      ? ticks - audio.timing.ticks
      : audio.timing.ticks - ticks;
  if (
    audio.sampleCount !== audio.timing.sampleCount ||
    difference * 1000n > BigInt(TRANSCRIPTION_DURATION_TOLERANCE_MS) * scale
  ) {
    return Result.err(createUnreadableAudioError());
  }
  return duration;
};

const readM4aDuration = (
  bytes: Uint8Array,
): Result<number, HandlerError<422>> => {
  const state: Mp4ScanState = {
    containers: [{ start: 0, end: bytes.length, kind: "root" }],
    tracks: [],
    hasFtyp: false,
    hasMoov: false,
    mediaBytes: 0,
    maximum: 0,
    chunks: 0,
    sampleEntries: 0,
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
  if (!state.hasFtyp || !state.hasMoov || state.mediaBytes === 0) {
    return Result.err(createUnreadableAudioError());
  }
  const duration = readAudioTrackDuration(state.tracks);
  return duration.isErr()
    ? Result.err(duration.error)
    : boundedDuration(Math.max(state.maximum, duration.value));
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
