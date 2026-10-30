import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { persistedDocumentAstSchema } from "@stll/legal-ast/document-ast";

import { corpusAstCensus } from "@/api/lib/case-law/corpus-ast-census";
import { CorpusPayloadUnavailableError } from "@/api/lib/errors/tagged-errors";

const validAst = {
  version: 1,
  source: { system: "test", documentId: "synthetic", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "b1",
      anchorId: "h-title",
      type: "heading",
      level: 1,
      inlines: [{ type: "text", text: "Synthetic decision" }],
      plainText: "Synthetic decision",
    },
  ],
};

const invalidAst = {
  ...validAst,
  blocks: [
    ...validAst.blocks,
    {
      id: "b2",
      anchorId: "h-title",
      type: "paragraph",
      inlines: [{ type: "text", text: "Body" }],
      plainText: "Body",
    },
  ],
};

describe("stored reader-schema census", () => {
  test("counts schema failures separately from unreadable and absent payloads across cursor batches", async () => {
    expect(v.safeParse(persistedDocumentAstSchema, validAst).success).toBe(
      true,
    );
    expect(v.safeParse(persistedDocumentAstSchema, invalidAst).success).toBe(
      false,
    );
    const row = (
      id: string,
      documentAst: unknown,
      astS3Key: string | null,
    ) => ({
      id,
      documentAst,
      astS3Key,
      adapterKey: "sk-courts",
      parserVersion: 17,
    });
    const first = [row("1", validAst, null), row("2", invalidAst, null)];
    const second = [
      row("3", {}, "invalid"),
      row("4", {}, "unreadable"),
      row("5", {}, null),
    ];
    const cursors: (string | undefined)[] = [];
    let pauses = 0;
    const counts = await corpusAstCensus({
      readBatch: async (after) => {
        cursors.push(after);
        if (after === undefined) {
          return first;
        }
        if (after === "2") {
          return second;
        }
        return [];
      },
      readPayload: async (key) => {
        if (key === "invalid") {
          return invalidAst;
        }
        throw new CorpusPayloadUnavailableError({
          message: "Synthetic unreadable payload",
          documentId: "synthetic",
          key,
        });
      },
      readTombstones: async () => new Set(),
      pause: async () => {
        pauses++;
      },
    });
    expect(cursors).toEqual([undefined, "2", "5"]);
    expect(pauses).toBe(2);
    expect(counts).toEqual([
      {
        adapterKey: "sk-courts",
        parserVersion: 17,
        published: 5,
        valid: 1,
        invalid: 2,
        unreadable: 1,
        withoutAst: 1,
      },
    ]);
  });

  test("keeps adapter and parser-version counts distinct without exposing payloads", async () => {
    let read = false;
    const counts = await corpusAstCensus({
      readBatch: async () => {
        if (read) {
          return [];
        }
        read = true;
        return [
          {
            id: "1",
            adapterKey: "sk-courts",
            parserVersion: 18,
            astS3Key: null,
            documentAst: validAst,
          },
          {
            id: "2",
            adapterKey: "sk-courts",
            parserVersion: 17,
            astS3Key: null,
            documentAst: invalidAst,
          },
          {
            id: "3",
            adapterKey: "sk-us",
            parserVersion: null,
            astS3Key: null,
            documentAst: null,
          },
        ];
      },
      readPayload: async () => validAst,
      readTombstones: async () => new Set(),
      pause: async () => {},
    });
    expect(counts).toEqual([
      {
        adapterKey: "sk-courts",
        parserVersion: 17,
        published: 1,
        valid: 0,
        invalid: 1,
        unreadable: 0,
        withoutAst: 0,
      },
      {
        adapterKey: "sk-courts",
        parserVersion: 18,
        published: 1,
        valid: 1,
        invalid: 0,
        unreadable: 0,
        withoutAst: 0,
      },
      {
        adapterKey: "sk-us",
        parserVersion: null,
        published: 1,
        valid: 0,
        invalid: 0,
        unreadable: 0,
        withoutAst: 1,
      },
    ]);
    expect(JSON.stringify(counts)).not.toContain("Synthetic decision");
  });
});
