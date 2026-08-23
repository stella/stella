import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { unzipSync } from "fflate";

import { parseVerifiedArtifact } from "../verified-artifact";

export const MULTIGRASCCO_PROVENANCE = {
  doi: "10.5281/zenodo.18847836",
  repository: "https://zenodo.org/records/18847836",
  version: "18847836",
  file: "MultiGraSCCo_annotations.zip",
  url: "https://zenodo.org/api/records/18847836/files/MultiGraSCCo_annotations.zip/content",
  sha256: "bfbd84d32a39dd53b0f63e0a3b49e423feb0188c686497ac7b9e62366cbb95ff",
  license: "CC-BY-4.0",
  split: "evaluation",
} as const;

const LANGUAGES = {
  Arabic: "ar",
  English: "en",
  French: "fr",
  German: "de",
  Italian: "it",
  Persian: "fa",
  Polish: "pl",
  Russian: "ru",
  Turkish: "tr",
  Ukrainian: "uk",
} as const;

const EXPECTED_DOCUMENTS_PER_LANGUAGE = 63;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const decoder = new TextDecoder();

export type MultiGraSCCoSpan = {
  readonly start: number;
  readonly end: number;
};

export type MultiGraSCCoDocument = {
  readonly id: string;
  readonly language: string;
  readonly text: string;
  readonly directSpans: readonly MultiGraSCCoSpan[];
  readonly indirectSpans: readonly MultiGraSCCoSpan[];
};

export type MultiGraSCCoCorpus = {
  readonly documents: readonly MultiGraSCCoDocument[];
  readonly sourceDocuments: number;
  readonly excludedDocuments: number;
};

type ParsedEntity =
  | { readonly status: "valid"; readonly start: number; readonly end: number }
  | { readonly status: "stale" };
type ParsedDocument = {
  readonly filename: string;
  readonly text: string;
  readonly entities: readonly ParsedEntity[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void => {
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${context} has an invalid object shape`);
  }
};

const codePointOffsets = (text: string): readonly number[] => {
  const offsets = [0];
  let utf16Offset = 0;
  for (const point of text) {
    utf16Offset += point.length;
    offsets.push(utf16Offset);
  }
  return offsets;
};

const parseRows = (bytes: Uint8Array, path: string): ParsedDocument[] => {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array`);
  const seen = new Set<string>();
  return value.map((row, rowIndex) => {
    if (!isRecord(row)) throw new Error(`${path} row ${rowIndex} is invalid`);
    exactKeys(row, ["filename", "text", "entities"], `${path} row ${rowIndex}`);
    const { filename, text, entities } = row;
    if (
      typeof filename !== "string" ||
      filename === "" ||
      typeof text !== "string" ||
      !Array.isArray(entities)
    ) {
      throw new Error(`${path} row ${rowIndex} has invalid fields`);
    }
    if (seen.has(filename)) throw new Error(`${path} duplicates ${filename}`);
    seen.add(filename);
    const offsets = codePointOffsets(text);
    const parsedEntities = entities.map((entity, entityIndex): ParsedEntity => {
      if (!isRecord(entity)) {
        throw new Error(`${path} entity ${entityIndex} is invalid`);
      }
      exactKeys(
        entity,
        ["start", "end", "text", "type"],
        `${path} entity ${entityIndex}`,
      );
      const { start, end, text: annotatedText, type } = entity;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        start < 0 ||
        typeof annotatedText !== "string" ||
        typeof type !== "string" ||
        type === ""
      ) {
        throw new Error(`${path} entity ${entityIndex} has invalid fields`);
      }
      const utf16Start = offsets[start];
      const utf16End = offsets[end];
      if (
        end <= start ||
        annotatedText === "" ||
        utf16Start === undefined ||
        utf16End === undefined ||
        text.slice(utf16Start, utf16End) !== annotatedText
      ) {
        return { status: "stale" };
      }
      return { status: "valid", start: utf16Start, end: utf16End };
    });
    return { filename, text, entities: parsedEntities };
  });
};

const indexRows = (
  rows: readonly ParsedDocument[],
  path: string,
  expectedDocuments: number,
): ReadonlyMap<string, ParsedDocument> => {
  if (rows.length !== expectedDocuments) {
    throw new Error(`${path} must contain ${expectedDocuments} documents`);
  }
  return new Map(rows.map((row) => [row.filename, row]));
};

const validatedSpans = (
  entities: readonly ParsedEntity[],
): readonly MultiGraSCCoSpan[] | undefined => {
  const spans: MultiGraSCCoSpan[] = [];
  for (const entity of entities) {
    if (entity.status === "stale") return undefined;
    spans.push({ start: entity.start, end: entity.end });
  }
  return spans;
};

export const parseMultiGraSCCoArchive = (
  bytes: Uint8Array,
  expectedDocumentsPerLanguage = EXPECTED_DOCUMENTS_PER_LANGUAGE,
): MultiGraSCCoCorpus => {
  if (
    !Number.isSafeInteger(expectedDocumentsPerLanguage) ||
    expectedDocumentsPerLanguage <= 0
  ) {
    throw new Error("expected MultiGraSCCo document count must be positive");
  }
  const archive = unzipSync(bytes);
  let expandedBytes = 0;
  for (const [path, entry] of Object.entries(archive)) {
    if (!path.startsWith("__MACOSX/") && !path.endsWith("/")) {
      expandedBytes += entry.byteLength;
    }
  }
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error("MultiGraSCCo archive exceeds the 16 MiB expanded limit");
  }

  const documents: MultiGraSCCoDocument[] = [];
  for (const [languageName, language] of Object.entries(LANGUAGES)) {
    const directPath = `MultiGraSCCo/${languageName}_PHI.json`;
    const indirectPath = `MultiGraSCCo/${languageName}_IPI.json`;
    const directBytes = archive[directPath];
    const indirectBytes = archive[indirectPath];
    if (directBytes === undefined || indirectBytes === undefined) {
      throw new Error(
        `MultiGraSCCo is missing the ${languageName} annotation pair`,
      );
    }
    const direct = indexRows(
      parseRows(directBytes, directPath),
      directPath,
      expectedDocumentsPerLanguage,
    );
    const indirect = indexRows(
      parseRows(indirectBytes, indirectPath),
      indirectPath,
      expectedDocumentsPerLanguage,
    );
    for (const filename of [...direct.keys()].sort()) {
      const directDocument = direct.get(filename);
      const indirectDocument = indirect.get(filename);
      if (
        directDocument === undefined ||
        indirectDocument === undefined ||
        directDocument.text !== indirectDocument.text
      ) {
        throw new Error(
          `MultiGraSCCo ${languageName}/${filename} has mismatched annotation pairs`,
        );
      }
      // The published archive contains translated documents whose annotations
      // retain stale source offsets. Exclude a whole document rather than
      // guessing spans from entity text; the report records this selection.
      const directSpans = validatedSpans(directDocument.entities);
      const indirectSpans = validatedSpans(indirectDocument.entities);
      if (directSpans === undefined || indirectSpans === undefined) continue;
      documents.push({
        id: `${language}/${filename}`,
        language,
        text: directDocument.text,
        directSpans,
        indirectSpans,
      });
    }
  }
  const sourceDocuments =
    Object.keys(LANGUAGES).length * expectedDocumentsPerLanguage;
  return {
    documents,
    sourceDocuments,
    excludedDocuments: sourceDocuments - documents.length,
  };
};

const cachePath = (): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `multigrassco-${MULTIGRASCCO_PROVENANCE.sha256}.zip`,
  );

const verified = (bytes: Uint8Array): boolean =>
  createHash("sha256").update(bytes).digest("hex") ===
  MULTIGRASCCO_PROVENANCE.sha256;

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("MultiGraSCCo download exceeds the 4 MiB size limit");
  }
  if (response.body === null)
    throw new Error("MultiGraSCCo returned an empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("MultiGraSCCo download exceeds the 4 MiB size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const loadVerifiedBytes = async (): Promise<Uint8Array> => {
  const target = cachePath();
  try {
    const cached = await readFile(target);
    if (!verified(cached))
      throw new Error("cached MultiGraSCCo checksum mismatch");
    return cached;
  } catch {
    const response = await fetch(MULTIGRASCCO_PROVENANCE.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `MultiGraSCCo download failed with HTTP ${response.status}`,
      );
    }
    const bytes = await readBounded(response);
    if (!verified(bytes))
      throw new Error("MultiGraSCCo download checksum mismatch");
    await mkdir(dirname(target), { recursive: true });
    const staged = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(staged, bytes);
    try {
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    return bytes;
  }
};

export const loadVerifiedMultiGraSCCo = async (): Promise<MultiGraSCCoCorpus> =>
  parseVerifiedArtifact({
    bytes: await loadVerifiedBytes(),
    expectedSha256: MULTIGRASCCO_PROVENANCE.sha256,
    name: "MultiGraSCCo evaluation corpus",
    parse: (bytes) => parseMultiGraSCCoArchive(bytes),
  });
