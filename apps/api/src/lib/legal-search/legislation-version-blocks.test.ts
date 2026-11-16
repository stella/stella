import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  readVersionAst,
  readVersionBlocks,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * A version whose AST lives in its own row is read without the database
 * handle, so the handle here refuses every use.
 */
const unusedDb = asTestRaw<LegislationReadDb>(async () =>
  panic("a row-held AST needs no database read"),
);

const versionRead = (documentAst: unknown) => ({
  row: {
    id: toSafeId<"legislationDocument">("0198e331-e578-7000-8000-0000000003a1"),
    astS3Key: null,
    documentAst,
  },
  legislationDb: unusedDb,
  step: "test.versionAst",
  surface: "pages" as const,
});

const paragraph = (id: string, anchorId: string, text: string) => ({
  id,
  anchorId,
  type: "paragraph",
  inlines: [{ type: "text", text }],
});

describe("stored legislation version ASTs", () => {
  test("a stored AST no reader can read is answered as absent, not thrown", async () => {
    const unreadable = {
      version: 1,
      blocks: [{ id: "p", anchorId: "p", type: "paragraph" }],
    };

    expect(await readVersionAst(versionRead(unreadable))).toBeNull();
    expect(await readVersionBlocks(versionRead(unreadable))).toEqual([]);
  });

  test("a stored AST repeating an anchor is served with the repeat re-keyed", async () => {
    const blocks = await readVersionBlocks(
      versionRead({
        version: 1,
        blocks: [
          paragraph("p1", "par_1", "§ 1"),
          paragraph("p2", "par_1", "§ 1 continued"),
        ],
      }),
    );

    expect(
      blocks.map(({ anchorId, plainText }) => [anchorId, plainText]),
    ).toEqual([
      ["par_1", "§ 1"],
      ["par_1-2", "§ 1 continued"],
    ]);
  });
});
