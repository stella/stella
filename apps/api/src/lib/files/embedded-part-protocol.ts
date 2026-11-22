import * as v from "valibot";

/** One file inside a stored container, read in the extraction worker. */
export const EMBEDDED_PART_WORKER_MODE = "embedded-part";

export const EMBEDDED_PART_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
  noPart: 23,
} as const;

/** The reply: one JSON header line, then the part's bytes. */
const EMBEDDED_PART_HEADER_END = 0x0a;

const headerSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ fileName: v.string(), mimeType: v.string() }),
);

export type EmbeddedPart = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export const encodeEmbeddedPart = ({
  fileName,
  mimeType,
  bytes,
}: EmbeddedPart): Uint8Array => {
  const header = new TextEncoder().encode(
    JSON.stringify({ fileName, mimeType }),
  );
  const reply = new Uint8Array(header.byteLength + 1 + bytes.byteLength);
  reply.set(header);
  reply[header.byteLength] = EMBEDDED_PART_HEADER_END;
  reply.set(bytes, header.byteLength + 1);
  return reply;
};

/** The part a reply carries, or null when it breaks the reply format. */
export const decodeEmbeddedPart = (reply: Uint8Array): EmbeddedPart | null => {
  const end = reply.indexOf(EMBEDDED_PART_HEADER_END);
  if (end === -1) {
    return null;
  }
  const header = v.safeParse(
    headerSchema,
    new TextDecoder().decode(reply.subarray(0, end)),
  );
  return header.success
    ? { ...header.output, bytes: reply.subarray(end + 1) }
    : null;
};
