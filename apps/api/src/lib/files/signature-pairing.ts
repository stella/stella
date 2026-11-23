import { Result } from "better-result";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { SignaturePreview } from "@stll/api-contract/signature";
import { normalizeUnicode } from "@stll/text-normalize";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import type { StatedDigest } from "@/api/lib/files/cms-signed-data";
import type { SignatureWorkerReply } from "@/api/lib/files/signature-preview-protocol";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

type SignedFile = Extract<
  SignaturePreview,
  { type: "signature" }
>["signedFiles"][number];

type FileContent = Extract<FieldContent, { type: "file" }>;

/** Documents one signature can name; more is a collision, not a pair. */
const MAX_SIGNED_FILES = 8;
/** Siblings hashed again for a digest other than the stored SHA-256. */
const MAX_REHASHED_FILES = 4;

const SIGNATURE_SUFFIX = /\.(?:p7s|sig|xades|xml)$/iu;
const HAS_EXTENSION = /\.[a-z0-9]{1,8}$/iu;
// `x.p7s` beside `x.pdf`: the formats a signed legal file usually has.
const SIGNED_FILE_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".txt",
  ".xml",
  ".xlsx",
  ".xls",
  ".jpg",
  ".png",
  ".zfo",
  ".isdoc",
] as const;

// SHA-256 is compared with the stored file's own hash, never recomputed.
// WebCrypto has no SHA-224, so a SHA-224 digest is not compared.
const REHASHED_ALGORITHMS = ["SHA-1", "SHA-384", "SHA-512"] as const;

type RehashedDigest = StatedDigest & {
  algorithm: (typeof REHASHED_ALGORITHMS)[number];
};

const isRehashed = (digest: StatedDigest): digest is RehashedDigest =>
  REHASHED_ALGORITHMS.some((algorithm) => algorithm === digest.algorithm);

const hexDigest = async (
  algorithm: RehashedDigest["algorithm"],
  bytes: ArrayBuffer,
) => Buffer.from(await crypto.subtle.digest(algorithm, bytes)).toString("hex");

/**
 * The names a signature file's own name points at: `x.pdf.p7s` and
 * `x.pdf.xades` sign `x.pdf`; `x.p7s` signs `x` with its usual extension.
 */
const conventionalSignedFileNames = (signatureFileName: string) => {
  const stem = signatureFileName.trim().replace(SIGNATURE_SUFFIX, "");
  if (stem === signatureFileName.trim() || stem.length === 0) {
    return [];
  }
  if (HAS_EXTENSION.test(stem)) {
    return [stem];
  }
  return SIGNED_FILE_EXTENSIONS.map((extension) => `${stem}${extension}`);
};

// File names compare as names, not as words: case folded, accents kept. The
// lookup folds stored names the same way, so `Contract.Pdf` is found too.
const nameKey = (name: string) => normalizeUnicode(name, "NFC").toLowerCase();
const sameName = (left: string, right: string) =>
  nameKey(left) === nameKey(right);

type Candidate = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  name: string;
  content: FileContent;
  foundByDigest: boolean;
};

type FindSignedFilesOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  signatureEntityId: SafeId<"entity">;
  signatureFileName: string;
  references: SignatureWorkerReply["references"];
};

const fileSha256Hex = sql<string>`(${fields.content}->>'sha256Hex')`;

/** More documents than the cap share the name or bytes: no pair to name. */
const completeRows = <TRow>(
  read: { type: "complete"; rows: TRow[] } | { type: "overflow" },
): TRow[] => (read.type === "complete" ? read.rows : []);

const readCandidates = async ({
  scopedDb,
  workspaceId,
  signatureEntityId,
  names,
  sha256Hexes,
}: {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  signatureEntityId: SafeId<"entity">;
  names: readonly string[];
  sha256Hexes: readonly string[];
}): Promise<Candidate[]> =>
  await scopedDb(async (tx) => {
    // Both reads stay inside the reader's own matter, through the reader's
    // scoped connection: a document the reader cannot open is never found.
    const select = {
      entityId: entities.id,
      fieldId: fields.id,
      name: entities.name,
      content: fields.content,
    };
    const documentInMatter = and(
      eq(entities.workspaceId, workspaceId),
      eq(entities.kind, "document"),
      ne(entities.id, signatureEntityId),
    );
    const fileInMatter = and(
      eq(fields.workspaceId, workspaceId),
      sql`${fields.content}->>'type' = 'file'`,
    );
    const byName =
      names.length === 0
        ? []
        : completeRows(
            await readBounded(
              tx
                .select(select)
                .from(entities)
                .innerJoin(
                  fields,
                  eq(fields.entityVersionId, entities.currentVersionId),
                )
                .where(
                  and(
                    documentInMatter,
                    fileInMatter,
                    inArray(sql`lower(${entities.name})`, [
                      ...new Set(names.map(nameKey)),
                    ]),
                  ),
                )
                .orderBy(asc(entities.name), asc(entities.id)),
              MAX_SIGNED_FILES,
            ),
          );
    const byDigest =
      sha256Hexes.length === 0
        ? []
        : completeRows(
            await readBounded(
              // One row per document, however many of its files match: the
              // cap counts documents.
              tx
                .selectDistinctOn([entities.createdAt, entities.id], select)
                .from(fields)
                .innerJoin(
                  entities,
                  eq(entities.currentVersionId, fields.entityVersionId),
                )
                .where(
                  and(
                    documentInMatter,
                    fileInMatter,
                    inArray(fileSha256Hex, [...sha256Hexes]),
                  ),
                )
                .orderBy(asc(entities.createdAt), asc(entities.id)),
              MAX_SIGNED_FILES,
            ),
          );
    const candidates = new Map<SafeId<"entity">, Candidate>();
    for (const [rows, foundByDigest] of [
      [byDigest, true],
      [byName, false],
    ] as const) {
      for (const row of rows) {
        if (row.content.type === "file" && !candidates.has(row.entityId)) {
          candidates.set(row.entityId, {
            entityId: row.entityId,
            fieldId: row.fieldId,
            name: row.name,
            content: row.content,
            foundByDigest,
          });
        }
      }
    }
    return [...candidates.values()].slice(0, MAX_SIGNED_FILES);
  });

/**
 * The stated digests that speak about this document: those of references
 * naming it, else those of references naming no file. A reference naming
 * another file says nothing about this one.
 */
const digestsFor = (
  candidate: Candidate,
  references: SignatureWorkerReply["references"],
): StatedDigest[] => {
  const named = references.filter(
    ({ fileName }) =>
      fileName !== null &&
      (sameName(fileName, candidate.name) ||
        sameName(fileName, candidate.content.fileName) ||
        sameName(sanitizeFilename(fileName), candidate.name)),
  );
  const relevant =
    named.length > 0
      ? named
      : references.filter(({ fileName }) => fileName === null);
  return relevant.flatMap(({ digest }) => (digest === null ? [] : [digest]));
};

/** Whether any of `digests` is the stored file's, hashing it once a method. */
const storedBytesMatch = async (
  bytes: ArrayBuffer,
  digests: readonly RehashedDigest[],
) => {
  const algorithms = [...new Set(digests.map(({ algorithm }) => algorithm))];
  const hashes = await Promise.all(
    algorithms.map(async (algorithm) => ({
      algorithm,
      hex: await hexDigest(algorithm, bytes),
    })),
  );
  return digests.some(({ algorithm, hex }) =>
    hashes.some((hash) => hash.algorithm === algorithm && hash.hex === hex),
  );
};

/**
 * The documents a detached signature appears to sign, in the reader's own
 * matter: by the signature file's name, the names it states, and the SHA-256
 * it states. A binding compares stored bytes to a stated digest only; it is
 * never a signature verification.
 */
export const findSignedFiles = async ({
  scopedDb,
  workspaceId,
  organizationId,
  signatureEntityId,
  signatureFileName,
  references,
}: FindSignedFilesOptions): Promise<SignedFile[]> => {
  const stated = references.flatMap(({ fileName }) =>
    fileName === null ? [] : [fileName, sanitizeFilename(fileName)],
  );
  const names = [
    ...new Set([...stated, ...conventionalSignedFileNames(signatureFileName)]),
  ];
  const sha256Hexes = [
    ...new Set(
      references.flatMap(({ digest }) =>
        digest?.algorithm === "SHA-256" ? [digest.hex] : [],
      ),
    ),
  ];
  if (names.length === 0 && sha256Hexes.length === 0) {
    return [];
  }
  const candidates = await readCandidates({
    scopedDb,
    workspaceId,
    signatureEntityId,
    names,
    sha256Hexes,
  });

  // Only a digest other than SHA-256 needs the stored bytes read again, and
  // only for a bounded number of documents.
  const plans = candidates.map((candidate) => {
    const digests = digestsFor(candidate, references);
    const sha256 = digests.filter(({ algorithm }) => algorithm === "SHA-256");
    const other = digests.filter(isRehashed);
    const sha256Matches = sha256.some(
      ({ hex }) => hex === candidate.content.sha256Hex.toLowerCase(),
    );
    return { candidate, digests, sha256, other, sha256Matches };
  });
  const rehashed = new Set(
    plans
      .filter(
        ({ candidate, other, sha256Matches }) =>
          !sha256Matches &&
          other.length > 0 &&
          candidate.content.sizeBytes <= FILE_SIZE_LIMIT_BYTES.document,
      )
      .slice(0, MAX_REHASHED_FILES)
      .map(({ candidate }) => candidate.entityId),
  );
  const signedFiles = await Promise.all(
    plans.map(
      async ({
        candidate,
        digests,
        sha256,
        other,
        sha256Matches,
      }): Promise<SignedFile> => {
        const signedFile = (binding: SignedFile["binding"]) => ({
          entityId: candidate.entityId,
          fieldId: candidate.fieldId,
          fileName: candidate.name,
          binding,
        });
        // No reference speaks about this document: found by its bytes, it
        // matches a stated digest; found by name alone, nothing is compared.
        if (digests.length === 0) {
          return signedFile(
            candidate.foundByDigest ? "digestMatches" : "notCompared",
          );
        }
        if (sha256Matches) {
          return signedFile("digestMatches");
        }
        if (other.length === 0) {
          return signedFile(
            sha256.length > 0 ? "digestDiffers" : "notCompared",
          );
        }
        // A digest left unchecked may still match: never call it different.
        if (!rehashed.has(candidate.entityId)) {
          return signedFile("notCompared");
        }
        const stored = await Result.tryPromise(
          async () =>
            await readStoredFile({
              key: createFileKey({
                organizationId,
                workspaceId,
                fileId: candidate.content.id,
                mimeType: candidate.content.mimeType,
              }),
              mimeType: candidate.content.mimeType,
            }),
        );
        // An unreadable file is not compared, never reported as different.
        if (stored.isErr()) {
          return signedFile("notCompared");
        }
        return signedFile(
          (await storedBytesMatch(stored.value.bytes, other))
            ? "digestMatches"
            : "digestDiffers",
        );
      },
    ),
  );
  const order = { digestMatches: 0, notCompared: 1, digestDiffers: 2 } as const;
  return signedFiles.toSorted(
    (left, right) => order[left.binding] - order[right.binding],
  );
};
