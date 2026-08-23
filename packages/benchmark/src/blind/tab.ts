import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseVerifiedArtifact } from "../verified-artifact";

export const TAB_PROVENANCE = {
  repository:
    "https://github.com/NorskRegnesentral/text-anonymization-benchmark",
  commit: "558e09e26d6b36f5f78440074e6a233946d98bd9",
  file: "echr_test.json",
  sha256: "cd0f0f15f84a8739654c7cf30c6be8ce27b051ef73974d39d792a0cb8c846379",
  license: "MIT",
} as const;

export const TAB_DEV_PROVENANCE = {
  ...TAB_PROVENANCE,
  file: "echr_dev.json",
  sha256: "8c3c7306f46b8d54debeb38ae11d8b0b8bcf4bdccbc3b6f13c12ad7be16893ec",
} as const;

type TabProvenance = {
  readonly repository: string;
  readonly commit: string;
  readonly file: string;
  readonly sha256: string;
  readonly license: string;
};

export const TAB_SAMPLE_SIZE = 12;
export const TAB_SAMPLE_SEED = "stella-blind-tab-v1";
const TAB_MAX_BYTES = 16 * 1024 * 1024;
const TAB_DOWNLOAD_TIMEOUT_MS = 30_000;

export type TabIdentifierType = "DIRECT" | "QUASI" | "NO_MASK";

export type TabMention = {
  readonly entityType: string;
  readonly entityId: string;
  readonly start: number;
  readonly end: number;
  readonly identifierType: TabIdentifierType;
};

export type TabDocument = {
  readonly id: string;
  readonly text: string;
  readonly annotations: readonly TabAnnotation[];
};

export type TabAnnotation = {
  readonly annotatorId: string;
  readonly mentions: readonly TabMention[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isIdentifierType = (value: unknown): value is TabIdentifierType =>
  value === "DIRECT" || value === "QUASI" || value === "NO_MASK";

const parseMention = (
  raw: unknown,
  text: string,
  documentId: string,
): TabMention => {
  if (!isRecord(raw)) {
    throw new Error(`TAB document ${documentId} contains an invalid mention`);
  }
  const { entity_type, entity_id, start_offset, end_offset, identifier_type } =
    raw;
  if (
    typeof entity_type !== "string" ||
    typeof entity_id !== "string" ||
    typeof start_offset !== "number" ||
    typeof end_offset !== "number" ||
    !isIdentifierType(identifier_type) ||
    !Number.isSafeInteger(start_offset) ||
    !Number.isSafeInteger(end_offset) ||
    start_offset < 0 ||
    end_offset <= start_offset ||
    end_offset > text.length
  ) {
    throw new Error(`TAB document ${documentId} contains an invalid mention`);
  }
  if (
    typeof raw["span_text"] !== "string" ||
    text.slice(start_offset, end_offset) !== raw["span_text"]
  ) {
    throw new Error(`TAB document ${documentId} contains a stale mention span`);
  }
  return {
    entityType: entity_type,
    entityId: entity_id,
    start: start_offset,
    end: end_offset,
    identifierType: identifier_type,
  };
};

const parseTabCorpus = (
  value: unknown,
  expectedSplit: "dev" | "test",
): TabDocument[] => {
  if (!Array.isArray(value)) {
    throw new Error("TAB corpus must be a JSON array");
  }
  const documents: TabDocument[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error("TAB corpus contains a malformed or non-test document");
    }
    const raw = item;
    if (
      typeof raw["doc_id"] !== "string" ||
      raw["dataset_type"] !== expectedSplit ||
      typeof raw["text"] !== "string" ||
      !isRecord(raw["annotations"])
    ) {
      throw new Error(
        `TAB corpus contains a malformed or non-${expectedSplit} document`,
      );
    }
    if (seen.has(raw["doc_id"])) {
      throw new Error(
        `TAB corpus contains duplicate document ${raw["doc_id"]}`,
      );
    }
    seen.add(raw["doc_id"]);

    const annotationEntries = Object.entries(raw["annotations"]);
    if (annotationEntries.length === 0) {
      throw new Error(`TAB document ${raw["doc_id"]} has no annotations`);
    }
    const annotations: TabAnnotation[] = [];
    for (const [annotatorId, annotation] of annotationEntries) {
      if (
        !isRecord(annotation) ||
        !Array.isArray(annotation["entity_mentions"])
      ) {
        throw new Error(
          `TAB document ${raw["doc_id"]} has malformed annotations`,
        );
      }
      const mentions: TabMention[] = [];
      for (const mention of annotation["entity_mentions"]) {
        mentions.push(parseMention(mention, raw["text"], raw["doc_id"]));
      }
      annotations.push({ annotatorId, mentions });
    }
    documents.push({
      id: raw["doc_id"],
      text: raw["text"],
      annotations,
    });
  }
  if (documents.length === 0) {
    throw new Error("TAB test corpus is empty");
  }
  return documents;
};

export const parseTabTestCorpus = (value: unknown): TabDocument[] =>
  parseTabCorpus(value, "test");

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const selectBlindSample = (
  documents: readonly TabDocument[],
  size = TAB_SAMPLE_SIZE,
): TabDocument[] => {
  if (!Number.isSafeInteger(size) || size <= 0 || size > documents.length) {
    throw new Error(`invalid TAB blind sample size ${size}`);
  }
  return [...documents]
    .sort((left, right) => {
      const byHash = compareStrings(
        digest(`${TAB_SAMPLE_SEED}\0${left.id}`),
        digest(`${TAB_SAMPLE_SEED}\0${right.id}`),
      );
      return byHash === 0 ? compareStrings(left.id, right.id) : byHash;
    })
    .slice(0, size)
    .sort((left, right) => compareStrings(left.id, right.id));
};

const cachePath = (provenance: TabProvenance): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `tab-${provenance.commit}-${provenance.file}`,
  );

const verifiedBytes = (bytes: Uint8Array, provenance: TabProvenance): boolean =>
  createHash("sha256").update(bytes).digest("hex") === provenance.sha256;

const readBoundedResponse = async (response: Response): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TAB_MAX_BYTES) {
    throw new Error("TAB download exceeds the 16 MiB size limit");
  }
  if (response.body === null) {
    throw new Error("TAB download returned an empty response body");
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > TAB_MAX_BYTES) {
      await reader.cancel();
      throw new Error("TAB download exceeds the 16 MiB size limit");
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

const loadVerifiedTabCorpus = async (
  provenance: TabProvenance,
  split: "dev" | "test",
): Promise<TabDocument[]> => {
  const target = cachePath(provenance);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(target);
    if (!verifiedBytes(bytes, provenance)) {
      throw new Error("cached TAB corpus checksum mismatch");
    }
  } catch {
    const url = `https://raw.githubusercontent.com/NorskRegnesentral/text-anonymization-benchmark/${provenance.commit}/${provenance.file}`;
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TAB_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`TAB download failed with HTTP ${response.status}`);
    }
    bytes = await readBoundedResponse(response);
    if (!verifiedBytes(bytes, provenance)) {
      throw new Error("TAB download checksum mismatch");
    }
    await mkdir(dirname(target), { recursive: true });
    const staged = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(staged, bytes);
    try {
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }
  return parseVerifiedArtifact({
    bytes,
    expectedSha256: provenance.sha256,
    name: `TAB ${split} split`,
    parse: (verified) =>
      parseTabCorpus(
        JSON.parse(new TextDecoder().decode(verified)) as unknown,
        split,
      ),
  });
};

export const loadVerifiedTabTestCorpus = async (): Promise<TabDocument[]> =>
  loadVerifiedTabCorpus(TAB_PROVENANCE, "test");

export const loadVerifiedTabDevCorpus = async (): Promise<TabDocument[]> =>
  loadVerifiedTabCorpus(TAB_DEV_PROVENANCE, "dev");
