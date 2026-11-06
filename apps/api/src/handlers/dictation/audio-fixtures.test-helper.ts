export const joinAudioBytes = (parts: readonly Uint8Array[]) => {
  const merged = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
};

export const makeAudioBox = (type: string, payload: Uint8Array) => {
  const box = new Uint8Array(payload.length + 8);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(new TextEncoder().encode(type), 4);
  box.set(payload, 8);
  return box;
};

export const makeWavAudioBytes = (durationMs = 1234) => {
  const dataSize = durationMs * 32;
  const bytes = new Uint8Array(dataSize + 44);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataSize, true);
  return bytes;
};

type M4aFixtureOptions = {
  movieDurationMs?: number;
  trackDurationMs?: number;
  sampleDurationMs?: number;
  sttsEntries?: readonly M4aSampleTimingEntry[];
  version?: 0 | 1;
};

export type M4aSampleTimingEntry = {
  sampleCount: number;
  sampleDelta: number;
};

export const makeM4aSttsBox = (entries: readonly M4aSampleTimingEntry[]) => {
  const payload = new Uint8Array(8 + entries.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(4, entries.length);
  let offset = 8;
  for (const { sampleCount, sampleDelta } of entries) {
    view.setUint32(offset, sampleCount);
    view.setUint32(offset + 4, sampleDelta);
    offset += 8;
  }
  return makeAudioBox("stts", payload);
};

export const makeM4aStszBox = (sampleCount: number) => {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(4, 6);
  view.setUint32(8, sampleCount);
  return makeAudioBox("stsz", payload);
};

export const makeM4aHandlerBox = (handler = "soun") => {
  const payload = new Uint8Array(25);
  payload.set(new TextEncoder().encode(handler), 8);
  return makeAudioBox("hdlr", payload);
};

type M4aDurationBoxOptions = {
  type: "mvhd" | "mdhd";
  durationMs: number;
  version?: 0 | 1 | undefined;
};

export const makeM4aDurationBox = ({
  type,
  durationMs,
  version = 0,
}: M4aDurationBoxOptions) => {
  const payload = new Uint8Array(
    (type === "mvhd" ? 100 : 24) + (version === 1 ? 12 : 0),
  );
  const view = new DataView(payload.buffer);
  payload[0] = version;
  const scaleOffset = version === 0 ? 12 : 20;
  view.setUint32(scaleOffset, 1000);
  if (version === 0) {
    view.setUint32(scaleOffset + 4, durationMs);
  } else {
    view.setBigUint64(scaleOffset + 4, BigInt(durationMs));
  }
  if (type === "mvhd") {
    const rateOffset = version === 0 ? 20 : 32;
    view.setUint32(rateOffset, 0x1_00_00);
    view.setUint16(rateOffset + 4, 0x1_00);
    for (const [offset, value] of [
      [0, 0x1_00_00],
      [16, 0x1_00_00],
      [32, 0x40_00_00_00],
    ] as const) {
      view.setUint32(rateOffset + 16 + offset, value);
    }
    view.setUint32(payload.length - 4, 2);
  }
  return makeAudioBox(type, payload);
};

type M4aTrackBoxOptions = {
  durationMs: number;
  handler?: "soun" | "vide";
  sampleDurationMs?: number | undefined;
  sttsEntries?: readonly M4aSampleTimingEntry[] | undefined;
  version?: 0 | 1 | undefined;
};

export const makeM4aTrackBox = ({
  durationMs,
  handler = "soun",
  sampleDurationMs = durationMs,
  sttsEntries = [{ sampleCount: 1, sampleDelta: sampleDurationMs }],
  version,
}: M4aTrackBoxOptions) =>
  makeAudioBox(
    "trak",
    makeAudioBox(
      "mdia",
      joinAudioBytes([
        makeM4aDurationBox({ type: "mdhd", durationMs, version }),
        makeM4aHandlerBox(handler),
        makeAudioBox(
          "minf",
          makeAudioBox(
            "stbl",
            joinAudioBytes([
              makeM4aSttsBox(sttsEntries),
              makeM4aStszBox(
                sttsEntries.reduce(
                  (total, entry) => total + entry.sampleCount,
                  0,
                ),
              ),
            ]),
          ),
        ),
      ]),
    ),
  );

/** Container metadata fixtures; duration tests do not decode AAC payloads. */
export const makeM4aAudioBytes = (
  durationMs = 1234,
  options: M4aFixtureOptions = {},
) => {
  const brand = new Uint8Array(16);
  brand.set(new TextEncoder().encode("M4A "));
  brand.set(new TextEncoder().encode("isomM4A "), 8);
  const sampleCount =
    options.sttsEntries?.reduce(
      (total, entry) => total + entry.sampleCount,
      0,
    ) ?? 1;
  const media = new Uint8Array(Math.min(sampleCount, 4096) * 6);
  if (media.length >= 6) {
    media.set([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);
  }
  return joinAudioBytes([
    makeAudioBox("ftyp", brand),
    makeAudioBox(
      "moov",
      joinAudioBytes([
        makeM4aDurationBox({
          type: "mvhd",
          durationMs: options.movieDurationMs ?? durationMs,
          version: options.version,
        }),
        makeM4aTrackBox({
          durationMs: options.trackDurationMs ?? durationMs,
          sampleDurationMs: options.sampleDurationMs,
          sttsEntries: options.sttsEntries,
          version: options.version,
        }),
      ]),
    ),
    makeAudioBox("mdat", media),
  ]);
};
