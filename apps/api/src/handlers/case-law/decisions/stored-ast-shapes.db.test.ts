import { panic } from "better-result";
/**
 * A stored decision row keeps whatever its writer stored, and a reader
 * reads it long after the writer changed. These rows hold AST shapes an
 * earlier parser wrote, or a value no reader can read, in the row's own
 * `document_ast` column, and the public read must still answer each one:
 * served as the current reader reads it, or as a typed state, never as a
 * failed request.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A decision title set over two lines, each read as the title heading. */
const titleLine = (id: string, text: string) => ({
  id,
  anchorId: "h-title",
  type: "heading",
  level: 1,
  role: "decision-title",
  inlines: [{ type: "text", text }],
  plainText: text,
});

const splitTitleAst = {
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
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
    titleLine("b1", "ROZSUDOK V MENE"),
    titleLine("b2", "SLOVENSKEJ REPUBLIKY"),
    {
      id: "b3",
      anchorId: "p1",
      type: "paragraph",
      inlines: [{ type: "text", text: "Body of the decision." }],
      plainText: "Body of the decision.",
    },
  ],
};

/** A declared paragraph without the inline run it requires. */
const unreadableAst = {
  version: 1,
  blocks: [{ id: "p", anchorId: "p", type: "paragraph" }],
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision read — stored AST shapes", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("decision read — stored AST shapes", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    /** Stores `ast` verbatim, as an earlier writer would have. */
    const insertDecision = async (ast: unknown, fulltext: string | null) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `ast-shape-${String(created.length)}-${suffix}`,
          court: "Synthetic court",
          country: "CZE",
          language: "cs",
          fulltext,
          documentAst: sql`${JSON.stringify(ast)}::text::jsonb`,
          documentUrl: "https://example.test/ast-shape.pdf",
        })
        .returning({ id: caseLawDecisions.id });
      const id = row?.id ?? panic("expected decision row");
      created.push(id);
      return id;
    };

    const read = async (id: SafeId<"caseLawDecision">) => {
      const decision =
        (await withRedistributableSubject(
          caseLawPublicReadDb,
          "pages",
          { kind: "id", id },
          async (subject) => await readDecisionHandler({ subject }),
        )) ?? panic("expected a redistributable subject");
      if (!("documentPending" in decision)) {
        return panic("expected a readable decision");
      }
      return decision;
    };

    beforeAll(async () => {
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.CZ_REGIONAL } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
          name: "Stored AST shape test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      sourceId = source?.id ?? panic("expected source row");
    });

    cleanUp(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
    });

    test("a row repeating a block identity is served whole, the repeat re-keyed", async () => {
      const decision = await read(
        await insertDecision(splitTitleAst, "ROZSUDOK V MENE"),
      );
      const blocks =
        decision.documentAst !== null && "blocks" in decision.documentAst
          ? decision.documentAst.blocks
          : panic("expected the stored document AST");

      expect(blocks.map(({ anchorId, id }) => [id, anchorId])).toEqual([
        ["b1", "h-title"],
        ["b2", "h-title-2"],
        ["b3", "p1"],
      ]);
      expect(decision.documentPending).toBe(false);
      expect(decision.documentReadFailed).toBe(false);
    });

    test("a row whose AST no reader can read is served from its fulltext", async () => {
      const decision = await read(
        await insertDecision(unreadableAst, "Text of the decision."),
      );

      expect(decision.documentAst).toBeNull();
      expect(decision.fulltext).toBe("Text of the decision.");
      expect(decision.documentPending).toBe(false);
      expect(decision.documentReadFailed).toBe(false);
    });

    test("a row whose AST no reader can read and with no text is a failed read", async () => {
      const decision = await read(await insertDecision(unreadableAst, null));

      expect(decision.documentAst).toBeNull();
      expect(decision.fulltext).toBeNull();
      expect(decision.documentReadFailed).toBe(true);
      expect(decision.documentUnavailable).toBe(false);
    });

    test("an unreadable AST beside an empty text stays a failed read, not an empty document", async () => {
      const decision = await read(await insertDecision(unreadableAst, ""));

      expect(decision.documentAst).toBeNull();
      expect(decision.documentReadFailed).toBe(true);
      expect(decision.documentUnavailable).toBe(false);
    });
  });
}
