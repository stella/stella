/**
 * The parse the scripts analyse, read from object storage.
 *
 * Most of the corpus keeps its parse as an object rather than in the row, so
 * a reader that only looked at `document_ast` would refuse most decisions.
 * This drives the scripts' reader through the real corpus reader against an
 * in-process object store, so the round trip that matters in production is
 * what the test proves: a trimmed row still yields its parse, an unreadable
 * object falls back to whatever copy the row kept, and a decision with
 * neither is reported as having no parse rather than throwing.
 *
 * The suite runs with corpus storage on (dual-write reads prefer the object,
 * exactly as canonical does), which the shared test setup otherwise forces
 * off. `env-base` resolves the mode once at import, so the mutation below
 * has to happen before anything env-bound loads: every import here is either
 * a type, which is erased, or dynamic.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type * as FakeS3Module from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

import type * as AstModule from "./decision-analysis.ast";
import type { DecisionAnalysisRow } from "./decision-analysis.logic";

const previousMode = process.env["CORPUS_STORAGE_MODE"];
process.env["CORPUS_STORAGE_MODE"] = "dual-write";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000d1",
);
const AST_KEY = "cze/cz-ns/decision-d1.ast.zst";

const paragraph = (anchorId: string, plainText: string) => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  plainText,
  inlines: [{ type: "text", text: plainText }],
});

const storedAst = {
  version: 1,
  blocks: [
    paragraph("b1", "Rozsudek"),
    paragraph("b2", "Soud dovolání zamítl."),
  ],
};

describe("readRowAst", () => {
  let readRowAst: typeof AstModule.readRowAst;
  let startFakeS3: typeof FakeS3Module.startFakeS3;
  let bucket: string;
  let compress: (bytes: Uint8Array) => Promise<Uint8Array>;
  let fake: FakeS3;

  const rowWith = (
    overrides: Partial<DecisionAnalysisRow> = {},
  ): DecisionAnalysisRow => ({
    id: DECISION_ID,
    language: "cs",
    court: "Nejvyšší soud",
    country: "CZE",
    decisionType: "rozsudek",
    documentAst: null,
    astS3Key: AST_KEY,
    contentHash: "c".repeat(64),
    analysis: null,
    redactedAt: null,
    source: { descriptor: null },
    ...overrides,
  });

  beforeAll(async () => {
    ({ readRowAst } = await import("./decision-analysis.ast"));
    ({ startFakeS3 } = await import("@/api/tests/helpers/fake-s3"));
    const { envBase } = await import("@/api/env-base");
    const { zstdCompressAsync } = await import("@/api/lib/compression");
    bucket = envBase.LEGAL_CORPUS_S3_BUCKET ?? envBase.S3_BUCKET;
    compress = zstdCompressAsync;
  });

  afterAll(() => {
    if (previousMode === undefined) {
      delete process.env["CORPUS_STORAGE_MODE"];
      return;
    }
    process.env["CORPUS_STORAGE_MODE"] = previousMode;
  });

  beforeEach(async () => {
    fake = startFakeS3();
    fake.put(
      bucket,
      AST_KEY,
      await compress(new TextEncoder().encode(JSON.stringify(storedAst))),
      "application/zstd",
    );
  });

  afterEach(() => {
    fake.stop();
  });

  test("reads the parse from object storage for a trimmed row", async () => {
    const ast = await readRowAst(rowWith());

    expect(ast?.blocks.map((block) => block.anchorId)).toEqual(["b1", "b2"]);
  });

  test("falls back to the row's own copy when the object is unreadable", async () => {
    fake.failNext({ method: "GET", code: "AccessDenied", status: 403 });

    const ast = await readRowAst(
      rowWith({
        documentAst: {
          version: 1,
          blocks: [paragraph("b9", "Kopie v řádku.")],
        },
      }),
    );

    expect(ast?.blocks.map((block) => block.anchorId)).toEqual(["b9"]);
  });

  // Neither an object nor a row copy: the run reports the decision rather
  // than ending on an exception, which is what lets a batch continue.
  test("answers null when there is no parse anywhere", async () => {
    fake.failNext({ method: "GET", code: "AccessDenied", status: 403 });

    expect(await readRowAst(rowWith())).toBeNull();
  });

  test("reads the row's column when the decision has no object at all", async () => {
    const ast = await readRowAst(
      rowWith({ astS3Key: null, contentHash: null, documentAst: storedAst }),
    );

    expect(ast?.blocks.map((block) => block.anchorId)).toEqual(["b1", "b2"]);
  });
});
