import { panic, TaggedError } from "better-result";

import {
  PayloadBudgetError,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { corpusMemberDigest } from "@/api/lib/legal-search/corpus-pack";

export class LinkRecallPayloadError extends TaggedError(
  "LinkRecallPayloadError",
)<{
  message: string;
}> {}

type LinkRecallObjectRequest = {
  key: string;
  range?: { offset: number; length: number };
};

type ReadLinkRecallPayloadOptions = {
  location: string;
  /** The caller bounds transfers and authorizes the corpus location before reading. */
  readObject: (request: LinkRecallObjectRequest) => Promise<Uint8Array>;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
};

/** Import-pure read seam for audits that do not initialize the API storage client. */
export const readLinkRecallPayload = async ({
  location,
  readObject,
  maxCompressedBytes,
  maxDecompressedBytes,
}: ReadLinkRecallPayloadOptions): Promise<string> => {
  if (
    !Number.isSafeInteger(maxCompressedBytes) ||
    maxCompressedBytes <= 0 ||
    !Number.isSafeInteger(maxDecompressedBytes) ||
    maxDecompressedBytes <= 0
  ) {
    return panic("Link recall payload budgets must be positive safe integers");
  }
  const parsed = parseCorpusLocation(location);
  let request: LinkRecallObjectRequest;
  switch (parsed.type) {
    case "object":
      request = { key: parsed.key };
      break;
    case "packed":
      if (
        parsed.length <= 0 ||
        !Number.isSafeInteger(parsed.offset + parsed.length)
      ) {
        throw new LinkRecallPayloadError({
          message: "Packed audit payload has an invalid byte range",
        });
      }
      if (parsed.length > maxCompressedBytes) {
        throw new PayloadBudgetError({
          message: "Packed audit payload exceeds the compressed-byte ceiling",
        });
      }
      request = {
        key: parsed.packKey,
        range: { offset: parsed.offset, length: parsed.length },
      };
      break;
    default: {
      parsed satisfies never;
      return panic("Unhandled link recall corpus location");
    }
  }
  const bytes = await readObject(request);
  if (bytes.byteLength > maxCompressedBytes) {
    throw new PayloadBudgetError({
      message: "Audit payload exceeds the compressed-byte ceiling",
    });
  }
  if (parsed.type === "packed") {
    if (bytes.byteLength !== parsed.length) {
      throw new LinkRecallPayloadError({
        message:
          "Packed audit payload does not match the declared range length",
      });
    }
    if (corpusMemberDigest(bytes) !== parsed.sha256) {
      throw new LinkRecallPayloadError({
        message: "Packed audit payload digest does not match its address",
      });
    }
  }
  return await zstdDecompressToStringBounded(bytes, maxDecompressedBytes);
};
