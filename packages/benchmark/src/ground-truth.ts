import { readdirSync } from "node:fs";
import { join } from "node:path";

import { type CommonLabel, isCommonLabel } from "./taxonomy";

/**
 * A ground-truth document is authored as an ordered list of segments so that
 * offsets are never written by hand: plain strings are non-PII filler, objects
 * carry a labelled entity. The loader concatenates segment text and derives
 * each entity's [start, end) span from its position in the joined string. This
 * makes offsets correct by construction and keeps the fixtures diffable.
 *
 * All fixture text is PUBLIC-SAFE SYNTHETIC: invented people, companies, and
 * identifiers in legal-ish en/cs/de prose. No real personal data.
 */
export type Segment = string | { readonly t: string; readonly label: string };

export type RawDocument = {
  readonly id: string;
  readonly language: string;
  readonly title: string;
  readonly segments: readonly Segment[];
};

export type GoldEntity = {
  readonly start: number;
  readonly end: number;
  readonly label: CommonLabel;
  readonly text: string;
};

export type GroundTruthDocument = {
  readonly id: string;
  readonly language: string;
  readonly title: string;
  readonly text: string;
  readonly entities: readonly GoldEntity[];
};

export const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

export const loadGroundTruthFile = async (
  file: string,
): Promise<GroundTruthDocument[]> => {
  const raw = (await Bun.file(
    join(FIXTURES_DIR, file),
  ).json()) as RawDocument[];
  return raw.map(buildGroundTruthDocument);
};

export const buildGroundTruthDocument = (
  raw: RawDocument,
): GroundTruthDocument => {
  let offset = 0;
  let text = "";
  const entities: GoldEntity[] = [];

  for (const segment of raw.segments) {
    if (typeof segment === "string") {
      text += segment;
      offset += segment.length;
      continue;
    }
    if (!isCommonLabel(segment.label)) {
      throw new Error(
        `document "${raw.id}": segment "${segment.t}" has unknown label "${segment.label}"`,
      );
    }
    const start = offset;
    const end = offset + segment.t.length;
    entities.push({ start, end, label: segment.label, text: segment.t });
    text += segment.t;
    offset = end;
  }

  return {
    id: raw.id,
    language: raw.language,
    title: raw.title,
    text,
    entities,
  };
};

/**
 * Load and expand every fixture file into scored ground-truth documents.
 * Fixture files are per-language JSON arrays of {@link RawDocument}.
 */
export const loadGroundTruth = async (): Promise<GroundTruthDocument[]> => {
  const files = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const documents: GroundTruthDocument[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    for (const doc of await loadGroundTruthFile(file)) {
      if (seenIds.has(doc.id)) {
        throw new Error(`duplicate document id "${doc.id}" in ${file}`);
      }
      seenIds.add(doc.id);
      documents.push(doc);
    }
  }

  if (documents.length === 0) {
    throw new Error(`no fixtures found in ${FIXTURES_DIR}`);
  }
  return documents;
};
