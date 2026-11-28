import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isUnreadBlock } from "@stll/legal-ast/document-ast";

import { toSafeId } from "@/api/lib/branded-types";
import { zstdCompress } from "@/api/lib/compression";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { CaseLawProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import type { CorpusProjectionMaterial } from "@/api/lib/legal-search/corpus-index-projection-materials";
import { loadCorpusProjectionRevisionBlock } from "@/api/lib/legal-search/corpus-index-projection-revision-block";
import {
  parsePersistedCorpusAst,
  parseStoredCorpusAst,
  readSizedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import {
  countStoredAstOutcome,
  emptyStoredAstReadCounts,
  type StoredAstOutcome,
} from "@/api/lib/legal-search/stored-ast-outcome";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

/**
 * Synthetic rows in the shapes stored ASTs take. The Slovak ones mirror real
 * rows of a national source, minimised: an empty object stored for a
 * decision whose structure ingestion did not keep, beside text or beside
 * none. No stored content is copied.
 */
const SK_DOCUMENT_ID = "019dd11a-0000-7000-8000-00000000a001";
const SK_STRUCTURELESS = {};

const paragraph = (id: string, text: string, role?: string) => ({
  id,
  anchorId: `a-${id}`,
  type: "paragraph",
  ...(role === undefined ? {} : { role }),
  inlines: [{ type: "text", text }],
});

const storedAst = (blocks: readonly unknown[]) => ({
  version: 1,
  source: {
    system: "sk-courts",
    documentId: "synthetic",
    webUrl: "https://example.test/decision",
    printUrl: "https://example.test/decision.pdf",
  },
  metadata: {
    caseNumber: "1T 1/2021",
    ecli: null,
    court: "Okresný súd",
    decisionDate: "2021-03-04",
    decisionType: "rozsudok",
    keywords: [],
    statutes: [],
  },
  blocks,
});

const DEGRADED_RECORD = "case_law.stored_ast_degraded";

let logs: ReturnType<typeof installRecordingLogger>;
beforeEach(() => {
  logs = installRecordingLogger();
});
afterEach(() => {
  logs.restore();
});

const degradedRecords = () =>
  logs.records.filter(({ message }) => message === DEGRADED_RECORD);

describe("a stored block of a type this reader does not declare", () => {
  const withUnknownBlock = storedAst([
    paragraph("p1", "Okresný súd rozhodol takto:"),
    {
      id: "z1",
      anchorId: "a-z1",
      type: "enumeration",
      items: [
        { inlines: [{ type: "text", text: "zmenkový platobný rozkaz" }] },
        { inlines: [{ type: "text", text: "trovy konania" }] },
      ],
    },
    paragraph("p2", "Poučenie: Proti tomuto rozsudku je prípustné odvolanie."),
  ]);

  test("round-trips as a kept unread block with its text and identity", () => {
    const { ast, outcome } = parseStoredCorpusAst(withUnknownBlock);
    const blocks = ast !== null && "blocks" in ast ? ast.blocks : [];
    const kept = blocks.find((block) => block.id === "z1");
    expect(kept === undefined ? false : isUnreadBlock(kept)).toBe(true);
    expect(kept).toMatchObject({
      type: "paragraph",
      role: "unknown",
      storedType: "enumeration",
      anchorId: "a-z1",
      plainText: "zmenkový platobný rozkaz\ntrovy konania",
    });
    expect(blocks.map(({ id }) => id)).toEqual(["p1", "z1", "p2"]);
    expect(outcome).toEqual({
      type: "degraded",
      counts: {
        "block-type": 1,
        "block-role": 0,
        "inline-type": 0,
        "block-identity": 0,
        "head-matter-order": 0,
      },
      vocabulary: ["block-type:enumeration"],
    });
  });

  test("its stored text reaches the projection's search text", () => {
    const { ast } = parseStoredCorpusAst(withUnknownBlock);
    const documents = buildCaseLawProjectionDocuments({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
      input: SK_INPUT,
      // The text payload names nothing of the block, so only the AST can
      // carry its words into the index.
      payload: { text: "Okresný súd rozhodol takto:", ast },
      revision: REVISION,
    });
    const indexed = documents.map(({ text }) => text).join("\n");
    expect(indexed).toContain("zmenkový platobný rozkaz");
    expect(indexed).toContain("trovy konania");
  });
});

describe("one typed report per degraded read", () => {
  const cases = [
    {
      kind: "block-type",
      measure: "measure.astBlockType",
      count: 1,
      blocks: [{ id: "x1", anchorId: "a-x1", type: "margin", text: "okraj" }],
      vocabulary: "block-type:margin",
    },
    {
      kind: "block-role",
      measure: "measure.astBlockRole",
      count: 1,
      blocks: [paragraph("p1", "Odôvodnenie", "reasoning-v9")],
      vocabulary: "block-role:paragraph/reasoning-v9",
    },
    {
      kind: "inline-type",
      measure: "measure.astInlineType",
      count: 1,
      blocks: [
        {
          ...paragraph("p1", ""),
          inlines: [{ type: "small-caps", text: "SÚD" }],
        },
      ],
      vocabulary: "inline-type:small-caps",
    },
    {
      kind: "block-identity",
      measure: "measure.astBlockIdentity",
      // The repeat holds both identities of the first block: two re-keys.
      count: 2,
      blocks: [paragraph("p1", "ROZSUDOK"), paragraph("p1", "V MENE")],
      vocabulary: undefined,
    },
    {
      kind: "head-matter-order",
      measure: "measure.astHeadMatterOrder",
      count: 1,
      blocks: [
        paragraph("p1", "Odôvodnenie", "argumentation"),
        paragraph("p2", "Právna veta", "headnotes"),
      ],
      vocabulary: undefined,
    },
  ] as const;

  test.each(cases)(
    "$kind: one record naming the document and the counts",
    ({ blocks, count, measure, vocabulary }) => {
      parsePersistedCorpusAst(storedAst(blocks), SK_DOCUMENT_ID);
      const records = degradedRecords();
      expect(records).toHaveLength(1);
      const attributes = records[0]?.attributes ?? {};
      expect(records[0]?.severityText).toBe("WARN");
      expect(attributes).toMatchObject({
        documentId: SK_DOCUMENT_ID,
        outcome: "degraded",
        [measure]: count,
        "failure.grade": "anticipated",
        "failure.reason": "stored_ast_degraded",
        "error.class": "StoredAstDegradedError",
      });
      // Only the kind this row carries is counted.
      expect(
        Object.keys(attributes).filter((key) => key.startsWith("measure.")),
      ).toEqual([measure]);
      expect(attributes["vocabulary"]).toBe(vocabulary);
    },
  );

  test("a row carrying several kinds is still one record with every count", () => {
    parsePersistedCorpusAst(
      storedAst([
        paragraph("p1", "ROZSUDOK"),
        paragraph("p1", "V MENE"),
        { id: "x1", anchorId: "a-x1", type: "margin", text: "okraj" },
        { id: "x2", anchorId: "a-x2", type: "margin", text: "okraj" },
        paragraph("p3", "Odôvodnenie", "reasoning-v9"),
      ]),
      SK_DOCUMENT_ID,
    );
    const records = degradedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes).toMatchObject({
      documentId: SK_DOCUMENT_ID,
      "measure.astBlockType": 2,
      "measure.astBlockIdentity": 2,
      "measure.astBlockRole": 1,
      vocabulary: "block-role:paragraph/reasoning-v9,block-type:margin",
    });
    expect(JSON.stringify(records)).not.toContain("okraj");
  });

  test("a stored name that is not an identifier is reported by its kind", () => {
    parsePersistedCorpusAst(
      storedAst([
        {
          id: "x1",
          anchorId: "a-x1",
          type: "Ján Novák, nar. 1.1.1970",
          text: "x",
        },
      ]),
      SK_DOCUMENT_ID,
    );
    expect(degradedRecords()[0]?.attributes?.["vocabulary"]).toBe(
      "block-type:unnamed",
    );
    expect(JSON.stringify(degradedRecords())).not.toContain("Novák");
  });

  test("a row read as written reports nothing", () => {
    parsePersistedCorpusAst(
      storedAst([paragraph("p1", "Rozsudok")]),
      SK_DOCUMENT_ID,
    );
    parsePersistedCorpusAst(null, SK_DOCUMENT_ID);
    expect(degradedRecords()).toEqual([]);
  });
});

describe("a stored AST stored without structure", () => {
  test("reads as structureless, with one report, never as a refusal", () => {
    const { ast, outcome } = parseStoredCorpusAst(SK_STRUCTURELESS);
    expect(ast).toEqual({});
    expect(outcome).toEqual({ type: "structureless" });
    parsePersistedCorpusAst(SK_STRUCTURELESS, SK_DOCUMENT_ID);
    expect(degradedRecords()).toMatchObject([
      { attributes: { documentId: SK_DOCUMENT_ID, outcome: "structureless" } },
    ]);
  });

  test("an object-store read returns the outcome it reported", async () => {
    const sized = await readSizedCorpusAst(
      "legal-corpus/documents/jurisdiction=SVK/synthetic/ast.json.zst",
      {
        readObject: async () => zstdCompress(JSON.stringify(SK_STRUCTURELESS)),
        readTombstones: async () => new Set<string>(),
        report: { documentId: SK_DOCUMENT_ID, jurisdiction: "SVK" },
      },
    );
    expect(sized.outcome).toEqual({ type: "structureless" });
    expect(degradedRecords()).toMatchObject([
      {
        attributes: {
          documentId: SK_DOCUMENT_ID,
          jurisdiction: "SVK",
          outcome: "structureless",
        },
      },
    ]);
  });
});

const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-00000000b001",
);

const SK_INPUT = {
  family: "case_law",
  documentId: SK_DOCUMENT_ID,
  sourceId: "0198e331-e578-7000-8000-00000000b003",
  jurisdiction: "svk",
  language: "sk",
  documentType: "judgment",
  contentHash: "c".repeat(64),
  redistributionEligible: true,
  redacted: false,
  listingOnly: false,
  provisionKeys: [],
  rankingSignals: {
    citationAuthorityBucket: 0,
    languageGroupKey: null,
    languageGroupShared: false,
  },
  vacatedFrom: null,
  caseNumber: "1T 1/2021",
  identifiers: [{ type: "docket", value: "1T 1/2021" }],
  court: "Okresný súd",
  courtId: null,
  decisionDate: "2021-03-04",
  ecli: null,
  metadata: null,
} as const satisfies CaseLawProjectionInput;

const materialOf = (entityId: string): CorpusProjectionMaterial => ({
  family: "case_law",
  manifest: CORPUS_INDEX_MANIFESTS.case_law_v5,
  input: { ...SK_INPUT, documentId: entityId },
  astS3Key: "legal-corpus/documents/jurisdiction=SVK/synthetic/ast.json.zst",
  textS3Key: "legal-corpus/documents/jurisdiction=SVK/synthetic/text.zst",
  lease: {
    intentId: REVISION,
    family: "case_law",
    generation: CORPUS_INDEX_MANIFESTS.case_law_v5.generation,
    entityId,
    epoch: 1n,
    fingerprint: "f".repeat(64),
    indexId: "case-law-v5-svk",
    leaseToken: "lease",
    leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    appendRequestCap: 512,
  },
});

describe("a batch counts the documents it read per outcome", () => {
  test("each built revision carries its outcome and the counters add them per kind", async () => {
    const outcomes: readonly StoredAstOutcome[] = [
      { type: "read" },
      parseStoredCorpusAst(
        storedAst([
          { id: "x1", anchorId: "a-x1", type: "margin", text: "okraj" },
          paragraph("p1", "Odôvodnenie", "reasoning-v9"),
        ]),
      ).outcome,
      parseStoredCorpusAst(
        storedAst([paragraph("p1", "A"), paragraph("p1", "B")]),
      ).outcome,
      parseStoredCorpusAst(SK_STRUCTURELESS).outcome,
      { type: "unreadable", reason: "stored_ast_invalid" },
      { type: "absent" },
    ];
    const counts = emptyStoredAstReadCounts();
    for (const [index, outcome] of outcomes.entries()) {
      const built = await loadCorpusProjectionRevisionBlock({
        runInTransaction: async () =>
          await Promise.resolve(panic("The fake payload reads no rows")),
        material: materialOf(`0198e331-e578-7000-8000-00000000c00${index}`),
        recordBuildMs: () => undefined,
        payloadReader: async () =>
          await Promise.resolve(
            Result.ok({
              text: "Okresný súd rozhodol takto:",
              ast: null,
              storedAst: outcome,
            }),
          ),
      });
      if (built.isErr()) {
        expect.unreachable(built.error.message);
      }
      expect(built.value.storedAst).toEqual(outcome);
      countStoredAstOutcome(counts, built.value.storedAst);
    }
    expect(counts).toEqual({
      degraded: 2,
      degradedByKind: {
        "block-type": 1,
        "block-role": 1,
        "inline-type": 0,
        "block-identity": 1,
        "head-matter-order": 0,
      },
      structureless: 1,
      unreadable: 1,
    });
  });
});
