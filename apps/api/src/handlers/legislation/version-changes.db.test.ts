import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import {
  backfillVersionChangesPage,
  decodeVersionChangesCursor,
  encodeVersionChangesCursor,
} from "@/api/handlers/legislation/version-changes-backfill";
import type { VersionChangesCursor } from "@/api/handlers/legislation/version-changes-backfill";
import { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * Each consolidation stores what it changed against the eligible one before
 * it. Ingestion writes the summaries a stored version can outdate, in
 * whatever order the versions arrive; the backfill fills the rest, and a run
 * repeated over a corpus it already filled computes and writes nothing.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"legislationSource">();

const corpus = {
  mode: "dual-write",
  write: async (input) => {
    const plan = planCorpusDocumentWrite(input);
    switch (plan.type) {
      case "put":
        return await Promise.resolve({
          type: "written",
          written: plan.written,
        });
      case "skipped-empty":
      case "skipped-unchanged":
        return await Promise.resolve(plan);
      default:
        return plan satisfies never;
    }
  },
} satisfies LegislationCorpusDependencies;

const heading = (text: string): Block => ({
  type: "heading",
  id: `h:${text}`,
  anchorId: `h:${text}`,
  level: 4,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (id: string, text: string): Block => ({
  type: "paragraph",
  id,
  anchorId: id,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const ast = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

/** Three wordings of one act: enacted, a one-word amendment, an addition. */
const WORDINGS = {
  enacted: [
    heading("§ 1"),
    paragraph("p1", "Nájemce smí byt užívat k podnikání."),
    heading("§ 2"),
    paragraph("p2", "Pronajímatel odevzdá byt ve stavu způsobilém."),
  ],
  amended: [
    heading("§ 1"),
    paragraph("p1", "Nájemce nesmí byt užívat k podnikání."),
    heading("§ 2"),
    paragraph("p2", "Pronajímatel odevzdá byt ve stavu způsobilém."),
  ],
  extended: [
    heading("§ 1"),
    paragraph("p1", "Nájemce nesmí byt užívat k podnikání."),
    heading("§ 2"),
    paragraph("p2", "Pronajímatel odevzdá byt ve stavu způsobilém."),
    heading("§ 3"),
    paragraph("p3", "Tento zákon nabývá účinnosti dnem vyhlášení."),
  ],
} as const;

const plainText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => ("plainText" in block ? block.plainText : ""))
    .join("\n");

const consolidation = ({
  eli,
  validFrom,
  lastDay,
  blocks,
}: {
  eli: string;
  validFrom: string;
  lastDay: string | null;
  blocks: readonly Block[];
}): LegislationDocumentInput => ({
  sourceId,
  eli,
  title: "Zákon o nájmu",
  country: "CZE",
  language: "cs",
  documentType: "zákon",
  effectiveDate: validFrom,
  version: {
    type: "consolidation",
    validFrom,
    end:
      lastDay === null
        ? { type: "open" }
        : { type: "last-day-in-force", on: lastDay },
  },
  fulltext: plainText(blocks),
  ast: ast([...blocks]),
  rawHash: `${eli}:${validFrom}:${plainText(blocks).length}`,
});

const storeAll = async (inputs: readonly LegislationDocumentInput[]) => {
  const ids: SafeId<"legislationDocument">[] = [];
  for (const input of inputs) {
    const result = await processLegislationDocument(input, scopedDb, {
      corpus,
    });
    if (result.type !== "stored") {
      return panic("fixture version was not stored");
    }
    ids.push(result.id);
  }
  return ids;
};

const summaries = async (eli: string) =>
  await db
    .select({
      validFrom: legislationDocuments.versionValidFrom,
      summary: legislationDocuments.changeSummary,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.eli, eli))
    .orderBy(asc(legislationDocuments.versionValidFrom));

const countsOf = async (eli: string) =>
  (await summaries(eli)).map(({ summary }) =>
    summary?.type === "compared" ? summary.counts : (summary?.type ?? null),
  );

const ONE_WORD = {
  provisions: { changed: 1, added: 0, removed: 0 },
  words: { inserted: 1, deleted: 1 },
};
const ONE_PROVISION_ADDED = {
  provisions: { changed: 0, added: 1, removed: 0 },
  words: { inserted: 8, deleted: 0 },
};

const work = (eli: string) => [
  consolidation({
    eli,
    validFrom: "2020-01-01",
    lastDay: "2020-12-31",
    blocks: WORDINGS.enacted,
  }),
  consolidation({
    eli,
    validFrom: "2021-01-01",
    lastDay: "2021-12-31",
    blocks: WORDINGS.amended,
  }),
  consolidation({
    eli,
    validFrom: "2022-01-01",
    lastDay: null,
    blocks: WORDINGS.extended,
  }),
];

const IN_ORDER = "/eli/cz/sb/2019/1";
const OUT_OF_ORDER = "/eli/cz/sb/2019/2";
const BACKFILLED = ["/eli/cz/sb/2019/3", "/eli/cz/sb/2019/4"];

const walk = async (apply: boolean, pageSize: number) => {
  const pages = [];
  const read = async (after: VersionChangesCursor | null) =>
    await backfillVersionChangesPage({
      db: scopedDb,
      after,
      pageSize,
      apply,
    });
  let page = await read(null);
  while (page.cursor !== null) {
    pages.push(page);
    // Every position a run prints is one it can resume from.
    page = await read(
      decodeVersionChangesCursor(encodeVersionChangesCursor(page.cursor)),
    );
  }
  return pages;
};

const total = (
  pages: readonly { planned: number; written: number }[],
  field: "planned" | "written",
) => pages.reduce((sum, page) => sum + page[field], 0);

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "version-changes-test",
    name: "Version changes test",
  });
});

afterAll(async () => {
  await client.close();
});

describe("ingestion", () => {
  test("stores each consolidation's changes against the one before it", async () => {
    await storeAll(work(IN_ORDER));

    expect(await countsOf(IN_ORDER)).toEqual([
      "first",
      ONE_WORD,
      ONE_PROVISION_ADDED,
    ]);
  });

  test("reaches the same summaries whatever order the versions arrive in", async () => {
    const [enacted, amended, extended] = work(OUT_OF_ORDER);
    if (
      enacted === undefined ||
      amended === undefined ||
      extended === undefined
    ) {
      return panic("fixture work has three versions");
    }
    await storeAll([extended, enacted, amended]);

    expect(await countsOf(OUT_OF_ORDER)).toEqual(await countsOf(IN_ORDER));
  });

  test("the versions list serves the counts of the wording each row holds", async () => {
    const [newest] = (
      await db
        .select({ id: legislationDocuments.id })
        .from(legislationDocuments)
        .where(eq(legislationDocuments.eli, IN_ORDER))
        .orderBy(asc(legislationDocuments.versionValidFrom))
    ).toReversed();
    if (newest === undefined) {
      return panic("fixture work was not stored");
    }
    const legislationDb: LegislationReadDb = async (read) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // The production driver answers `execute` with the rows themselves;
        // PGlite wraps them in a result object.
        const tx = new Proxy(roleTx, {
          get: (target, property, receiver) => {
            if (property !== "execute") {
              return Reflect.get(target, property, receiver);
            }
            return async (...args: Parameters<typeof roleTx.execute>) =>
              (await roleTx.execute(...args)).rows;
          },
        });
        // SAFETY: this PGlite transaction executes under the production
        // public-law role; the proxy adapts only execute's result shape.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
        return await read(tx as unknown as LegislationReadTransaction);
      });

    const page = await listStatuteVersionsHandler({
      documentId: newest.id,
      query: {},
      legislationDb,
      surface: "pages",
    });
    if (!("items" in page)) {
      return panic("version list was refused");
    }

    expect(page.items.map(({ changes }) => changes)).toEqual([
      ONE_PROVISION_ADDED,
      ONE_WORD,
      null,
    ]);
  });
});

describe("backfill", () => {
  beforeAll(async () => {
    const stored = await Promise.all(
      BACKFILLED.map(async (eli) => await storeAll(work(eli))),
    );
    // As versions stored before ingestion wrote summaries hold them.
    await db
      .update(legislationDocuments)
      .set({ changeSummary: null })
      .where(inArray(legislationDocuments.id, stored.flat()));
  });

  test("a report counts the missing summaries and writes nothing", async () => {
    const pages = await walk(false, 1);

    expect(total(pages, "planned")).toBe(6);
    expect(total(pages, "written")).toBe(0);
    for (const eli of BACKFILLED) {
      expect(await countsOf(eli)).toEqual([null, null, null]);
    }
  });

  test("an apply fills them, one Work per page, as ingestion would have", async () => {
    const pages = await walk(true, 1);

    expect(total(pages, "planned")).toBe(6);
    expect(total(pages, "written")).toBe(6);
    for (const eli of BACKFILLED) {
      expect(await countsOf(eli)).toEqual(await countsOf(IN_ORDER));
    }
  });

  test("a repeated run computes and writes nothing, and leaves every summary as it was", async () => {
    const before = await Promise.all(BACKFILLED.map(summaries));
    const pages = await walk(true, 2);

    expect(total(pages, "planned")).toBe(0);
    expect(total(pages, "written")).toBe(0);
    expect(await Promise.all(BACKFILLED.map(summaries))).toEqual(before);
  });

  test("a rewritten wording outdates its own summary and the next one, and only those", async () => {
    const [eli] = BACKFILLED;
    if (eli === undefined) {
      return panic("fixture has a backfilled Work");
    }
    // A parser fix rewrites the middle version's AST in place.
    await db
      .update(legislationDocuments)
      .set({ documentAst: ast([...WORDINGS.enacted]) })
      .where(eq(legislationDocuments.versionValidFrom, "2021-01-01"));

    const pages = await walk(true, 10);

    // Every Work's middle version changed, so each recomputes two summaries.
    expect(total(pages, "planned")).toBe(2 * 4);
    expect(await countsOf(eli)).toEqual([
      "first",
      {
        provisions: { changed: 0, added: 0, removed: 0 },
        words: { inserted: 0, deleted: 0 },
      },
      {
        provisions: { changed: 1, added: 1, removed: 0 },
        words: { inserted: 9, deleted: 1 },
      },
    ]);
  });
});
