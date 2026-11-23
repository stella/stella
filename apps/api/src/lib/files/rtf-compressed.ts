/**
 * Compressed RTF ([MS-OXRTFCP]): the form Outlook stores a message's rich
 * text body in (`PidTagRtfCompressed`), in `.msg` files and TNEF streams.
 * A stream is either stored as is (`MELA`) or LZ77-compressed against a
 * 4096-byte dictionary that starts with a fixed run of RTF (`LZFu`). The
 * output is held to the size its header states and to `maxBytes`, and a
 * compressed stream's CRC is checked before anything is read from it.
 */
import { Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

class CompressedRtfError extends TaggedError("CompressedRtfError")<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const HEADER_BYTES = 16;
/** `LZFu`, little-endian: the stream is compressed. */
const COMPRESSED = 0x75_46_5a_4c;
/** `MELA`, little-endian: the stream is stored uncompressed. */
const UNCOMPRESSED = 0x41_4c_45_4d;
const DICTIONARY_BYTES = 4096;

/** The dictionary's starting content ([MS-OXRTFCP] 2.1.2.1), 207 bytes. */
export const COMPRESSED_RTF_PREBUFFER = new TextEncoder().encode(
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman " +
    "\\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New " +
    "RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par " +
    "\\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx",
);

/**
 * The CRC [MS-OXRTFCP] 2.1.3.2 gives a compressed stream: the IEEE CRC-32,
 * started at zero and not inverted at the end.
 */
export const compressedRtfCrc = (bytes: Uint8Array): number =>
  // Seeded with all ones, the standard CRC-32 starts the register at zero;
  // subtracting from all ones undoes its final inversion.
  0xff_ff_ff_ff - Bun.hash.crc32(bytes, 0xff_ff_ff_ff);

const invalid = (message: string) =>
  Result.err(new CompressedRtfError({ message, reason: "invalid" }));

/** The RTF a compressed RTF stream holds. */
export const decompressRtf = (
  bytes: Uint8Array,
  { maxBytes }: { maxBytes: number },
): Result<Uint8Array, CompressedRtfError> => {
  if (bytes.byteLength < HEADER_BYTES) {
    return invalid("The compressed RTF header is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The compressed size counts every byte after its own field.
  const end = view.getUint32(0, true) + 4;
  const rawSize = view.getUint32(4, true);
  const type = view.getUint32(8, true);
  if (end < HEADER_BYTES || end > bytes.byteLength) {
    return invalid("The compressed RTF size runs past its stream");
  }
  if (rawSize > maxBytes) {
    return Result.err(
      new CompressedRtfError({
        message: "The RTF is larger than a body may be",
        reason: "limit",
      }),
    );
  }
  const content = bytes.subarray(HEADER_BYTES, end);
  if (type === UNCOMPRESSED) {
    return content.byteLength < rawSize
      ? invalid("The stored RTF is shorter than its header states")
      : Result.ok(content.slice(0, rawSize));
  }
  if (type !== COMPRESSED) {
    return invalid("The RTF is neither compressed nor stored");
  }
  if (compressedRtfCrc(content) !== view.getUint32(12, true)) {
    return invalid("The compressed RTF fails its CRC");
  }

  const dictionary = new Uint8Array(DICTIONARY_BYTES);
  dictionary.set(COMPRESSED_RTF_PREBUFFER);
  let write = COMPRESSED_RTF_PREBUFFER.byteLength;
  const output = new Uint8Array(rawSize);
  let written = 0;
  const emit = (byte: number): boolean => {
    if (written >= rawSize) {
      return false;
    }
    output[written] = byte;
    written += 1;
    dictionary[write] = byte;
    write = (write + 1) % DICTIONARY_BYTES;
    return true;
  };

  let at = 0;
  while (at < content.byteLength) {
    const control = content[at] ?? 0;
    at += 1;
    for (let bit = 0; bit < 8 && at < content.byteLength; bit += 1) {
      if (Math.floor(control / 2 ** bit) % 2 === 0) {
        if (!emit(content[at] ?? 0)) {
          return invalid("The compressed RTF outgrows its stated size");
        }
        at += 1;
        continue;
      }
      if (at + 1 >= content.byteLength) {
        return invalid("A compressed RTF reference is truncated");
      }
      const reference = (content[at] ?? 0) * 256 + (content[at + 1] ?? 0);
      at += 2;
      const offset = Math.floor(reference / 16);
      // A reference to the write position itself ends the stream.
      if (offset === write) {
        return Result.ok(output.slice(0, written));
      }
      const length = (reference % 16) + 2;
      for (let copied = 0; copied < length; copied += 1) {
        const byte = dictionary[(offset + copied) % DICTIONARY_BYTES] ?? 0;
        if (!emit(byte)) {
          return invalid("The compressed RTF outgrows its stated size");
        }
      }
    }
  }
  return invalid("The compressed RTF has no end marker");
};
