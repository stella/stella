import { Result, TaggedError } from "better-result";

import {
  type ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { declareFingerprintFields } from "@stll/errors";

import type { ZipEntry } from "@/api/lib/file-scan/zip";
import { archivePathKey } from "@/api/lib/files/archive-path-key";
import {
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";

const MIMETYPE_ENTRY = "mimetype";
const METADATA_DIRECTORY = "META-INF";
const METADATA_KEY = archivePathKey(METADATA_DIRECTORY);
const MAX_MIMETYPE_BYTES = 64;
export type AsicMimeType =
  typeof ASIC_E_FILE_FORMAT.mimeType | typeof ASIC_S_FILE_FORMAT.mimeType;

type AsicMember = { fileName: string; bytes: Uint8Array };
type NamedEntry = { fileName: string; entry: ZipEntry };

export class AsicParseError extends TaggedError("AsicParseError")<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const invalid = (message: string) =>
  Result.err(new AsicParseError({ message, reason: "invalid" }));

const indexMembers = (entries: ReadonlyMap<string, ZipEntry>) => {
  const payload: NamedEntry[] = [];
  const metadata = new Set<string>();
  let mimetype: ZipEntry | undefined;
  for (const [fileName, entry] of entries) {
    const isDirectory = fileName.endsWith("/");
    const root = fileName.split("/", 1).at(0);
    if (root === undefined) {
      return invalid("The container has an invalid entry path");
    }
    const rootKey = archivePathKey(root);
    if (rootKey === MIMETYPE_ENTRY) {
      if (fileName !== MIMETYPE_ENTRY) {
        return invalid("The container has an ambiguous mimetype entry");
      }
      mimetype = entry;
    } else if (rootKey === METADATA_KEY) {
      if (!fileName.startsWith(`${METADATA_DIRECTORY}/`)) {
        return invalid("The container has an ambiguous metadata directory");
      }
      if (!isDirectory && entry.uncompressedSize > 0) {
        metadata.add(fileName.slice(METADATA_DIRECTORY.length + 1));
      }
    } else if (!isDirectory) {
      payload.push({ fileName, entry });
    }
  }
  return Result.ok({ payload, metadata, mimetype });
};

// ETSI EN 319 162-1 §§4.3.3.2, 4.4.3.2 and 4.4.4.2. Only use entry
// names for recognition. The signature and manifest bytes are never parsed.
const SIMPLE_EVIDENCE = new Set([
  "signatures.xml",
  "signature.p7s",
  "signatures.p7s", // Also used in the ETSI Annex B.1.1 example.
  "timestamp.tst",
  "evidencerecord.ers",
  "evidencerecord.xml",
]);
const EXTENDED_MANIFEST = /^ASiCManifest[^/]*\.xml$/u;
const EVIDENCE_RECORD_MANIFEST = /^ASiCEvidenceRecordManifest[^/]*\.xml$/u;

const hasExtendedEvidence = (metadata: ReadonlySet<string>): boolean => {
  const names = [...metadata];
  return (
    names.some((name) => /signatures?[^/]*\.xml$/u.test(name)) ||
    (names.some((name) => EXTENDED_MANIFEST.test(name)) &&
      names.some((name) =>
        /^[^/]*(?:signature[^/]*\.p7s|timestamp[^/]*\.tst)$/u.test(name),
      )) ||
    (names.some((name) => EVIDENCE_RECORD_MANIFEST.test(name)) &&
      names.some((name) =>
        /^[^/]*evidencerecord[^/]*\.(?:ers|xml)$/u.test(name),
      ))
  );
};

const hasExpectedProfile = ({
  payload,
  metadata,
  hasMimeType,
  expectedMimeType,
}: {
  payload: readonly NamedEntry[];
  metadata: ReadonlySet<string>;
  hasMimeType: boolean;
  expectedMimeType: AsicMimeType;
}): boolean => {
  const first = payload.at(0);
  const isSimple =
    payload.length === 1 &&
    first !== undefined &&
    !first.fileName.includes("/") &&
    [...metadata].filter((name) => SIMPLE_EVIDENCE.has(name)).length === 1 &&
    ![...metadata].some(
      (name) =>
        EXTENDED_MANIFEST.test(name) || EVIDENCE_RECORD_MANIFEST.test(name),
    );
  const isExtended = payload.length > 0 && hasExtendedEvidence(metadata);
  const expectsSimple = expectedMimeType === ASIC_S_FILE_FORMAT.mimeType;
  // One root document and signatures.xml alone may describe either profile.
  if (!hasMimeType && isSimple && isExtended) {
    return false;
  }
  return expectsSimple ? isSimple : isExtended;
};

export const readAsicContainer = async (
  bytes: Uint8Array,
  expectedMimeType: AsicMimeType,
): Promise<Result<{ members: AsicMember[] }, AsicParseError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return Result.err(
      new AsicParseError({
        message: archive.error.message,
        reason: archive.error.reason,
      }),
    );
  }
  const inventory = indexMembers(archive.value);
  if (inventory.isErr()) {
    return Result.err(inventory.error);
  }
  const { payload, metadata, mimetype } = inventory.value;
  if (mimetype !== undefined) {
    if (mimetype.uncompressedSize > MAX_MIMETYPE_BYTES) {
      return invalid("The container has an invalid mimetype entry");
    }
    // Some legacy producer output compresses mimetype. Treat it as a bounded
    // label, independently of the optional ZIP magic-number placement.
    const marker = readArchiveEntry(mimetype);
    if (marker.isErr()) {
      return invalid(marker.error.message);
    }
    if (new TextDecoder().decode(marker.value) !== expectedMimeType) {
      return invalid("The container does not match the expected ASiC format");
    }
  }
  if (
    !hasExpectedProfile({
      payload,
      metadata,
      hasMimeType: mimetype !== undefined,
      expectedMimeType,
    })
  ) {
    return invalid("The container does not match the expected ASiC format");
  }
  const members: AsicMember[] = [];
  for (const { entry, fileName } of payload) {
    const member = readArchiveEntry(entry);
    if (member.isErr()) {
      return invalid(member.error.message);
    }
    members.push({ fileName, bytes: member.value });
  }
  return Result.ok({ members });
};
