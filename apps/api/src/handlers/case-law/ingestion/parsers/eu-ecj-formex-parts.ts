import { panic } from "better-result";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/lib/legal-search/ingestion-types";

export const FORMEX_ARCHIVE_PREFIX = "formex-archive:";

/** Keep archive member bytes and names, including non-XML assets. */
export const encodeEcjFormexArchive = (
  entries: readonly (readonly [string, Uint8Array])[],
): string =>
  FORMEX_ARCHIVE_PREFIX +
  encodeSourceRawEnvelope(
    Object.fromEntries(
      entries.map(([name, bytes]) => [
        name,
        Buffer.from(bytes).toString("base64"),
      ]),
    ),
  );

/** Historical raw parts contain a single XML stream instead of an archive. */
export const ecjFormexDocuments = (payload: string): readonly string[] => {
  if (!payload.startsWith(FORMEX_ARCHIVE_PREFIX)) {return [payload];}
  const entries = decodeSourceRawEnvelope(
    payload.slice(FORMEX_ARCHIVE_PREFIX.length),
  );
  if (entries === null) {panic("Invalid stored Formex archive envelope");}
  return Object.values(entries).map((encoded) =>
    Buffer.from(encoded, "base64").toString("utf-8"),
  );
};
