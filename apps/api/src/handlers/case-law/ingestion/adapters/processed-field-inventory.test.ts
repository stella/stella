/**
 * Every source declares every processed field, and the declaration holds
 * against what the source's parser makes of its recorded documents.
 *
 * 1. The inventory covers exactly the registered sources.
 * 2. Every recording a declaration names exists and is read by that source's
 *    own parser (`PROCESSED_FIELD_EVIDENCE_READERS`).
 * 3. Per field, `provided` must show in the parsed recording and a factual
 *    skip (`source-lacks`, `publisher-removes`) must not be contradicted by
 *    it; a `not-extracted` skip with a recording must show the field left
 *    unextracted, so fixing the parser forces the declaration to follow.
 * 4. Backlog skips and unrecorded claims agree exactly with the committed
 *    baseline, which only shrinks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { extractCourtParagraphNumbers } from "@stll/legal-ast/court-paragraph-numbers";
import type { Block } from "@stll/legal-ast/document-ast";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/adapters/processed-field-backlog-baseline.json";
import {
  BACKLOG_SKIP_REASONS,
  PROCESSED_FIELD_INVENTORY,
  PROCESSED_FIELD_SKIP_REASONS,
  PROCESSED_FIELDS,
  type ProcessedFieldDisposition,
  type ProcessedFieldId,
  type ProcessedFieldSourceKey,
} from "@/api/lib/legal-search/processed-field-inventory";
import {
  API_ROOT,
  type EvidenceDocument,
  PROCESSED_FIELD_EVIDENCE_READERS,
} from "@/api/tests/helpers/processed-field-evidence";

const isSourceKey = (key: string): key is ProcessedFieldSourceKey =>
  Object.hasOwn(PROCESSED_FIELD_INVENTORY, key);

const SOURCES = Object.keys(PROCESSED_FIELD_INVENTORY).filter(isSourceKey);

const declarations = SOURCES.flatMap((source) =>
  PROCESSED_FIELDS.map((field) => ({
    source,
    field,
    disposition: PROCESSED_FIELD_INVENTORY[source][field],
  })),
);

const pairKey = (source: string, field: string) => `${source}|${field}`;

const baselinePairs = (lists: Readonly<Record<string, readonly string[]>>) =>
  Object.entries(lists)
    .flatMap(([source, fields]) =>
      fields.map((field) => pairKey(source, field)),
    )
    .toSorted();

// ── court-paragraph-numbers ──────────────────────────────

const paragraphNumbers = (blocks: readonly Block[]): number[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph" && block.number !== undefined
      ? [block.number]
      : [],
  );

/**
 * Steps that do not continue a numbering: a number below the previous one
 * that does not restart a run at 1 (a separate opinion), or a jump over more
 * than two numbers.
 */
const irregularSteps = (numbers: readonly number[]): number =>
  numbers.slice(1).filter((number, index) => {
    const previous = numbers[index] ?? 0;
    return number === 1 ? false : number <= previous || number - previous > 3;
  }).length;

/** Problems with one recorded document, per declared disposition. */
const PROCESSED_FIELD_CHECKS: Readonly<
  Record<
    ProcessedFieldId,
    (
      disposition: ProcessedFieldDisposition,
      documents: readonly EvidenceDocument[],
    ) => string[]
  >
> = {
  "court-paragraph-numbers": (disposition, documents) => {
    const numbered = documents.filter(
      ({ ast }) => paragraphNumbers(ast.blocks).length >= 2,
    );
    // Numbering still sitting in the text: the extractor would move it.
    const leftInText = documents.filter(({ ast }) =>
      extractCourtParagraphNumbers(ast.blocks).blocks.some((block, index) => {
        const original = ast.blocks[index];
        return (
          block.type === "paragraph" &&
          original?.type === "paragraph" &&
          block.number !== original.number
        );
      }),
    );
    if (disposition.disposition === "provided") {
      const problems = leftInText.map(
        ({ id }) => `${id}: paragraph numbering left in the text`,
      );
      for (const { id, ast } of numbered) {
        const numbers = paragraphNumbers(ast.blocks);
        const allowed = 2 + Math.floor(numbers.length / 20);
        if (
          numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
        ) {
          problems.push(
            `${id}: a paragraph number that is not a positive integer`,
          );
        }
        if (irregularSteps(numbers) > allowed) {
          problems.push(
            `${id}: ${String(irregularSteps(numbers))} irregular steps in ${numbers.join(",")}`,
          );
        }
      }
      if (numbered.length === 0) {
        problems.push("no recorded document carries paragraph numbers");
      }
      return problems;
    }
    switch (disposition.reason) {
      // "Numbering left in the text" is read with the extractor's marker
      // shapes — `[N]`, `N.`, `N)` opening a paragraph, as Czech and Slovak
      // courts print them. A source that numbers paragraphs another way
      // (a margin cell, "Rn. N") is not caught by it, so a factual skip for
      // such a source also has to hold against `numbered` alone, which is.
      case PROCESSED_FIELD_SKIP_REASONS.SOURCE_LACKS:
      case PROCESSED_FIELD_SKIP_REASONS.PUBLISHER_REMOVES:
        return [...numbered, ...leftInText].map(
          ({ id }) => `${id}: declared without numbering, but numbered`,
        );
      case PROCESSED_FIELD_SKIP_REASONS.NOT_EXTRACTED:
        return [
          ...numbered.map(
            ({ id }) => `${id}: declared not extracted, but extracted`,
          ),
          ...(leftInText.length === 0
            ? ["declared not extracted, but no recording shows numbering"]
            : []),
        ];
      case PROCESSED_FIELD_SKIP_REASONS.UNASSESSED:
        return [];
      default: {
        disposition.reason satisfies never;
        return [`unknown reason ${String(disposition.reason)}`];
      }
    }
  },
};

describe("processed-field inventory", () => {
  test("covers exactly the registered sources", () => {
    const registered = listSourceRegistrations()
      .map(({ source }) => source.key)
      .toSorted();
    expect(SOURCES.toSorted()).toEqual(registered);
  });

  test("states every how, justification and missing-recording reason in words", () => {
    // The constructors reject a blank literal at compile time; a value built
    // at run time reaches them as `string` and is checked here.
    const blank = declarations.flatMap(({ source, field, disposition }) => {
      const texts = [
        disposition.disposition === "provided"
          ? disposition.how
          : disposition.justification,
        ...(disposition.evidence.kind === "unrecorded"
          ? [disposition.evidence.reason]
          : disposition.evidence.fixtures),
      ];
      return texts.some((text) => text.trim().length === 0)
        ? [pairKey(source, field)]
        : [];
    });
    expect(blank).toEqual([]);
  });

  test("names only recordings that exist and that the source can read", () => {
    const problems = declarations.flatMap(({ source, field, disposition }) => {
      if (disposition.evidence.kind !== "recording") {
        return [];
      }
      const unreadable =
        PROCESSED_FIELD_EVIDENCE_READERS[source] === null
          ? [`${source} ${field}: names a recording but has no reader`]
          : [];
      return [
        ...unreadable,
        ...disposition.evidence.fixtures.flatMap((fixture) =>
          existsSync(path.join(API_ROOT, fixture))
            ? []
            : [`${source} ${field}: ${fixture} does not exist`],
        ),
      ];
    });
    expect(problems).toEqual([]);
  });

  test("a source with a reader names a recording for some field", () => {
    const idle = SOURCES.filter(
      (source) =>
        PROCESSED_FIELD_EVIDENCE_READERS[source] !== null &&
        PROCESSED_FIELDS.every(
          (field) =>
            PROCESSED_FIELD_INVENTORY[source][field].evidence.kind !==
            "recording",
        ),
    );
    expect(idle).toEqual([]);
  });

  test("backlog skips agree with the baseline in both directions", () => {
    for (const reason of BACKLOG_SKIP_REASONS) {
      const declared = declarations
        .filter(
          ({ disposition }) =>
            disposition.disposition === "skipped" &&
            disposition.reason === reason,
        )
        .map(({ source, field }) => pairKey(source, field))
        .toSorted();
      expect({ reason, pairs: declared }).toEqual({
        reason,
        pairs: baselinePairs(baseline.skipped[reason]),
      });
    }
  });

  test("unrecorded claims agree with the baseline in both directions", () => {
    const declared = declarations
      .filter(({ disposition }) => disposition.evidence.kind === "unrecorded")
      .map(({ source, field }) => pairKey(source, field))
      .toSorted();
    expect(declared).toEqual(baselinePairs(baseline.unrecorded));
  });

  test("a factual skip is backed by a recording", () => {
    const unbacked = declarations.filter(
      ({ disposition }) =>
        disposition.disposition === "skipped" &&
        !BACKLOG_SKIP_REASONS.some((reason) => reason === disposition.reason) &&
        disposition.evidence.kind !== "recording",
    );
    expect(unbacked.map(({ source, field }) => pairKey(source, field))).toEqual(
      [],
    );
  });

  describe.each(
    declarations.filter(
      ({ disposition }) => disposition.evidence.kind === "recording",
    ),
  )("$source $field", ({ source, field, disposition }) => {
    test("holds against the parsed recordings", async () => {
      const reader = PROCESSED_FIELD_EVIDENCE_READERS[source];
      if (reader === null || disposition.evidence.kind !== "recording") {
        throw new Error(`${source} has no evidence reader`);
      }
      const documents = (
        await Promise.all(disposition.evidence.fixtures.map(reader))
      ).flat();
      expect(documents.length).toBeGreaterThan(0);
      expect(PROCESSED_FIELD_CHECKS[field](disposition, documents)).toEqual([]);
    });
  });
});
