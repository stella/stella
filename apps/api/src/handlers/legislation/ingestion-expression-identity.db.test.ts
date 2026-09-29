import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  LEGISLATION_WRITER_CONTRACT,
  processLegislationDocument,
} from "@/api/handlers/legislation/ingestion";
import type {
  LegislationCorpusDependencies,
  ProcessLegislationResult,
} from "@/api/handlers/legislation/ingestion";
import { toSafeId } from "@/api/lib/branded-types";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type {
  LegislationDocumentInput,
  VersionWindow,
  VersionWindowEnd,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The writer finds a version by the publisher's id, adopts a row written
 * before ids existed in place (same UUID), and never lets two writers, or a
 * writer and a stale row, end up overwriting the wrong version.
 */

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000f01",
);
const NAMESPACE = "esel";
const IRI_BASE = "https://example.test/esel-esb/eli/cz/sb";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const corpus = {
  mode: "off",
  write: async (input) => {
    const plan = planCorpusDocumentWrite(input);
    return await Promise.resolve(
      plan.type === "put"
        ? { type: "written" as const, written: plan.written }
        : plan,
    );
  },
} satisfies LegislationCorpusDependencies;

type VersionOptions = {
  act: string;
  validFrom: string;
  /** The IRI the version carries in its metadata. */
  iri?: string;
  /** Whether the connector supplies the publisher id (the new contract). */
  withId?: boolean;
  title?: string;
  end?: VersionWindowEnd;
};

const iriOf = (act: string, validFrom: string) =>
  `${IRI_BASE}/${act}/${validFrom}`;

const version = ({
  act,
  validFrom,
  iri = iriOf(act, validFrom),
  withId = true,
  title = `Act ${act}`,
  end = { type: "open" },
}: VersionOptions): LegislationDocumentInput => ({
  sourceId: SOURCE_ID,
  eli: `eli/cz/sb/${act}`,
  title,
  country: "CZE",
  language: "cs",
  version: { type: "consolidation", validFrom, end },
  ...(withId ? { expression: { publisherId: `${NAMESPACE}:${iri}` } } : {}),
  fulltext: `§ 1 ${title}`,
  metadata: { versionIri: iri },
  rawHash: `raw-${act}-${validFrom}`,
});

const store = async (
  input: LegislationDocumentInput,
  writer: ScopedDb = scopedDb,
): Promise<Extract<ProcessLegislationResult, { type: "stored" }>> => {
  const result = await processLegislationDocument(input, writer, { corpus });
  if (result.type !== "stored") {
    return panic(`expected a stored version, got ${result.type}`);
  }
  return result;
};

const rowsOf = async (act: string) =>
  await db
    .select({
      id: legislationDocuments.id,
      publisherId: legislationDocuments.publisherExpressionId,
      title: legislationDocuments.title,
      validFrom: legislationDocuments.versionValidFrom,
      validTo: legislationDocuments.versionValidTo,
      kind: legislationDocuments.expressionKind,
      disposition: legislationDocuments.windowDisposition,
      basis: legislationDocuments.windowDispositionBasis,
    })
    .from(legislationDocuments)
    .where(
      and(
        eq(legislationDocuments.sourceId, SOURCE_ID),
        eq(legislationDocuments.eli, `eli/cz/sb/${act}`),
      ),
    )
    .orderBy(asc(legislationDocuments.versionValidFrom));

const claimsOf = async (documentId: string): Promise<number> => {
  const { rows } = await db.execute<{ claims: number }>(sql`
    SELECT count(*)::int AS claims FROM expression_claim_log
    WHERE document_id = ${documentId}::uuid
  `);
  return rows.at(0)?.claims ?? 0;
};

/**
 * Two writers whose calls pause after the given call numbers until both have
 * reached them, so the interleaving under test is the one that runs rather
 * than whichever the scheduler picks.
 */
const lockstepWriters = (pauseAfterCalls: readonly number[]) => {
  const gates = new Map(
    pauseAfterCalls.map((call) => {
      let arrived = 0;
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const arrive = async () => {
        arrived += 1;
        if (arrived === 2) {
          open();
        }
        await opened;
      };
      return [call, arrive] as const;
    }),
  );
  const writer = (): ScopedDb => {
    let calls = 0;
    return async (fn) => {
      const result = await scopedDb(fn);
      calls += 1;
      await gates.get(calls)?.();
      return result;
    };
  };
  return [writer(), writer()] as const;
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "expression-writer-test",
    name: "Expression writer test",
    expressionNamespace: NAMESPACE,
  });
  // Every successful claim (an id going from null to set) leaves one row, so
  // a test can count claims rather than infer them.
  await db.execute(sql`
    CREATE TABLE expression_claim_log (document_id uuid NOT NULL)
  `);
  await db.execute(sql`
    CREATE FUNCTION log_expression_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO expression_claim_log VALUES (NEW.id);
      RETURN NULL;
    END;
    $$
  `);
  await db.execute(sql`
    CREATE TRIGGER expression_claim_log
    AFTER UPDATE OF publisher_expression_id ON legislation_documents
    FOR EACH ROW
    WHEN (OLD.publisher_expression_id IS NULL AND NEW.publisher_expression_id IS NOT NULL)
    EXECUTE FUNCTION log_expression_claim()
  `);
});

afterAll(async () => {
  await client.close();
});

describe("legislation writer identity", () => {
  test("a row stored without an id is adopted in place and keeps its UUID", async () => {
    const legacy = await store(
      version({ act: "2012/89", validFrom: "2025-07-01", withId: false }),
    );
    expect(await rowsOf("2012/89")).toMatchObject([{ publisherId: null }]);

    const adopted = await store(
      version({
        act: "2012/89",
        validFrom: "2025-07-01",
        title: "Act 2012/89, corrected",
      }),
    );

    expect(adopted).toMatchObject({
      id: legacy.id,
      inserted: false,
      skipped: false,
    });
    expect(await rowsOf("2012/89")).toEqual([
      expect.objectContaining({
        id: legacy.id,
        publisherId: `${NAMESPACE}:${iriOf("2012/89", "2025-07-01")}`,
        title: "Act 2012/89, corrected",
      }),
    ]);
    expect(await claimsOf(legacy.id)).toBe(1);
  });

  test("a legacy row whose start the publisher moved is adopted by its IRI, in place", async () => {
    const act = "2011/88";
    const iri = iriOf(act, "version-a");
    const legacy = await store(
      version({ act, validFrom: "2019-01-01", iri, withId: false }),
    );

    const moved = await store(version({ act, validFrom: "2019-02-01", iri }));

    expect(moved).toMatchObject({ id: legacy.id, inserted: false });
    expect(await rowsOf(act)).toEqual([
      expect.objectContaining({
        id: legacy.id,
        publisherId: `${NAMESPACE}:${iri}`,
        validFrom: "2019-02-01",
      }),
    ]);
  });

  test("a legacy row with no stored IRI is adopted by its window", async () => {
    const act = "2010/87";
    const legacyInput = version({
      act,
      validFrom: "2018-01-01",
      withId: false,
    });
    const legacy = await store({ ...legacyInput, metadata: {} });

    const adopted = await store(version({ act, validFrom: "2018-01-01" }));

    expect(adopted).toMatchObject({ id: legacy.id, inserted: false });
    expect(await rowsOf(act)).toHaveLength(1);
  });

  test("an unchanged version still persists the id it was claimed with", async () => {
    const legacy = await store(
      version({ act: "2013/90", validFrom: "2020-01-01", withId: false }),
    );

    const replay = await store(
      version({ act: "2013/90", validFrom: "2020-01-01" }),
    );

    expect(replay).toMatchObject({ id: legacy.id, skipped: true });
    expect(await rowsOf("2013/90")).toEqual([
      expect.objectContaining({
        id: legacy.id,
        publisherId: `${NAMESPACE}:${iriOf("2013/90", "2020-01-01")}`,
      }),
    ]);
  });

  test("two writers adopting one legacy row: one claim, one row, one UUID", async () => {
    const legacy = await store(
      version({ act: "2014/91", validFrom: "2021-01-01", withId: false }),
    );
    // Both look the id up, and miss, before either claims.
    const [first, second] = lockstepWriters([1]);
    const input = version({ act: "2014/91", validFrom: "2021-01-01" });

    const results = await Promise.all([
      store(input, first),
      store(input, second),
    ]);

    expect(results.map(({ id }) => id)).toEqual([legacy.id, legacy.id]);
    expect(await rowsOf("2014/91")).toHaveLength(1);
    expect(await claimsOf(legacy.id)).toBe(1);
  });

  test("two writers storing one new version converge on one row", async () => {
    // Both miss, find nothing to claim, miss again, then both insert.
    const [first, second] = lockstepWriters([1, 2, 3]);
    const input = version({ act: "2015/92", validFrom: "2022-01-01" });

    const results = await Promise.all([
      store(input, first),
      store(input, second),
    ]);

    const rows = await rowsOf("2015/92");
    expect(rows).toHaveLength(1);
    const row = rows.at(0) ?? panic("expected the version's row");
    expect(results.map(({ id }) => id)).toEqual([row.id, row.id]);
    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
  });

  test("two writers storing one version under different starts converge on one row", async () => {
    // Both miss, find nothing to claim, miss again, then both insert: the
    // identity lock makes the second find the first's row.
    const [first, second] = lockstepWriters([1, 2, 3]);
    const iri = iriOf("2015/93", "version-a");

    const results = await Promise.all([
      store(version({ act: "2015/93", validFrom: "2022-01-01", iri }), first),
      store(version({ act: "2015/93", validFrom: "2022-02-01", iri }), second),
    ]);

    const rows = await rowsOf("2015/93");
    expect(rows).toHaveLength(1);
    const row = rows.at(0) ?? panic("expected the version's row");
    expect(results.map(({ id }) => id)).toEqual([row.id, row.id]);
  });

  test("a work kept as one text is stored as unversioned, and a legacy row is reclassified", async () => {
    const act = "2009/86";
    const unversioned = {
      ...version({ act, validFrom: "2009-01-01" }),
      version: { type: "unversioned" as const },
      expression: { publisherId: `${NAMESPACE}:work:eli/cz/sb/${act}` },
    };
    const legacy = await store({ ...unversioned, expression: undefined });
    // A row written before kinds were stored reads as a consolidation.
    await db
      .update(legislationDocuments)
      .set({ expressionKind: "consolidation" })
      .where(eq(legislationDocuments.id, legacy.id));

    const replay = await store(unversioned);

    expect(replay).toMatchObject({ id: legacy.id, skipped: false });
    const [row] = await db
      .select({
        kind: legislationDocuments.expressionKind,
        publisherId: legislationDocuments.publisherExpressionId,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, legacy.id));
    expect(row).toEqual({
      kind: "unversioned",
      publisherId: `${NAMESPACE}:work:eli/cz/sb/${act}`,
    });
  });

  test("a stored IRI naming another version is not adopted or overwritten", async () => {
    await store(
      version({
        act: "2016/93",
        validFrom: "2023-01-01",
        iri: iriOf("2016/93", "stored-version"),
        withId: false,
      }),
    );

    const conflict = await store(
      version({ act: "2016/93", validFrom: "2023-01-01", title: "Intruder" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(conflict).toBeInstanceOf(Error);
    expect(await rowsOf("2016/93")).toEqual([
      expect.objectContaining({ publisherId: null, title: "Act 2016/93" }),
    ]);
  });

  test("a corrected window and disposition update the version's row in place", async () => {
    const act = "2006/110";
    const first = await store(version({ act, validFrom: "2017-01-01" }));
    // A classification the publisher later corrects, recorded out of band.
    await db
      .update(legislationDocuments)
      .set({
        windowDisposition: "invalid-window",
        windowDispositionBasis: "reversed",
      })
      .where(eq(legislationDocuments.id, first.id));

    const corrected = await store(
      version({
        act,
        validFrom: "2017-01-01",
        end: { type: "exclusive", on: "2020-04-01" },
      }),
    );

    expect(corrected).toMatchObject({ id: first.id, inserted: false });
    expect(await rowsOf(act)).toEqual([
      expect.objectContaining({
        id: first.id,
        validTo: "2020-04-01",
        disposition: "effective",
        basis: null,
      }),
    ]);
  });

  test("a withdrawn version listed again is restored under the same UUID", async () => {
    const act = "2017/94";
    const input = version({ act, validFrom: "2018-01-01" });
    const stored = await store(input);
    await db
      .update(legislationDocuments)
      .set({
        windowDisposition: "withdrawn",
        windowDispositionBasis: "publisher-unlisted",
      })
      .where(eq(legislationDocuments.id, stored.id));

    // The same content: only the disposition differs from what is stored.
    const relisted = await store({ ...input, origin: "live" });

    expect(relisted).toMatchObject({ id: stored.id, skipped: false });
    expect(await rowsOf(act)).toEqual([
      expect.objectContaining({
        id: stored.id,
        disposition: "effective",
        basis: null,
      }),
    ]);
  });

  test("an id outside the source's namespace is refused", async () => {
    const input = version({ act: "2018/95", validFrom: "2019-01-01" });
    const refused = await store({
      ...input,
      expression: { publisherId: `slovlex:${iriOf("2018/95", "2019-01-01")}` },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(Error);
    expect(await rowsOf("2018/95")).toEqual([]);
  });

  test("every write this writer makes declares its contract", async () => {
    // The shape of the fence a later migration arms.
    await db.execute(sql`
      CREATE FUNCTION test_writer_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('stella.legislation_writer_contract', true)
           IS DISTINCT FROM ${sql.raw(`'${LEGISLATION_WRITER_CONTRACT}'`)} THEN
          RAISE EXCEPTION 'undeclared legislation writer';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_writer_fence
      BEFORE INSERT OR UPDATE OF source_hash ON legislation_documents
      FOR EACH ROW EXECUTE FUNCTION test_writer_fence()
    `);
    try {
      const act = "2019/96";
      await store(version({ act, validFrom: "2019-06-01", withId: false }));
      await store(version({ act, validFrom: "2019-06-01", title: "Revised" }));
      await store(version({ act, validFrom: "2020-06-01" }));
      expect(await rowsOf(act)).toHaveLength(2);

      const undeclared = await db
        .update(legislationDocuments)
        .set({ sourceHash: "0".repeat(64) })
        .where(eq(legislationDocuments.eli, `eli/cz/sb/${act}`))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(undeclared).toBeInstanceOf(Error);
    } finally {
      await db.execute(
        sql`DROP TRIGGER test_writer_fence ON legislation_documents`,
      );
    }
  });

  test("a version that cannot apply is stored as stated, and each correction lands on its row", async () => {
    const act = "2005/78";
    const iri = iriOf(act, "v1");
    const typed = (window: VersionWindow) => ({
      ...version({ act, validFrom: "2006-01-01", iri }),
      version: window,
    });
    // Closed the day before it opened: replaced before it took effect.
    const neverInForce = typed({
      type: "never-in-force",
      validFrom: "2006-01-01",
      end: { type: "last-day-in-force", on: "2005-12-31" },
      basis: "replaced-same-day",
    });

    const first = await store(neverInForce);
    const asStated = await rowsOf(act);
    const corrected = await store(
      typed({
        type: "consolidation",
        validFrom: "2006-01-01",
        end: { type: "open" },
      }),
    );
    const effective = await rowsOf(act);
    const reverted = await store(neverInForce);
    const replayed = await store(neverInForce);

    expect(asStated).toEqual([
      expect.objectContaining({
        id: first.id,
        publisherId: `${NAMESPACE}:${iri}`,
        validFrom: "2006-01-01",
        validTo: "2006-01-01",
        kind: "consolidation",
        disposition: "never-in-force",
        basis: "replaced-same-day",
      }),
    ]);
    expect([corrected.id, reverted.id]).toEqual([first.id, first.id]);
    expect(effective).toEqual([
      expect.objectContaining({
        validTo: null,
        disposition: "effective",
        basis: null,
      }),
    ]);
    expect(await rowsOf(act)).toEqual(asStated);
    expect(replayed).toMatchObject({ id: first.id, skipped: true });
  });

  test("a promulgated text carries its own kind", async () => {
    const act = "2012/89-promulgated";
    const input = version({ act, validFrom: "2012-03-22" });
    const promulgated = {
      ...input,
      expression: {
        publisherId: `${NAMESPACE}:${iriOf(act, "0000-00-00")}`,
        kind: "promulgated",
      },
    } as const satisfies LegislationDocumentInput;

    const first = await store(promulgated);
    const replayed = await store(promulgated);

    expect(await rowsOf(act)).toEqual([
      expect.objectContaining({
        id: first.id,
        kind: "promulgated",
        disposition: "effective",
        basis: null,
      }),
    ]);
    expect(replayed).toMatchObject({ id: first.id, skipped: true });
  });

  test("a typed version without the publisher's id, or a kind its window contradicts, is refused", async () => {
    const act = "2013/90-refused";
    const input = version({ act, validFrom: "2014-01-01" });
    const refusal = async (refused: LegislationDocumentInput) =>
      await store(refused).then(
        () => null,
        (error: unknown) => error,
      );

    const withoutId = await refusal({
      ...version({ act, validFrom: "2014-01-01", withId: false }),
      version: {
        type: "invalid-window",
        validFrom: "2014-01-01",
        end: { type: "exclusive", on: "2013-01-01" },
        basis: "reversed",
      },
    });
    // A dated version declared a work kept as one text.
    const contradicted = await refusal({
      ...input,
      expression: {
        publisherId: input.expression?.publisherId ?? "",
        kind: "unversioned",
      },
    });

    expect(String(withoutId)).toContain("needs the publisher's id");
    expect(String(contradicted)).toContain("contradicts its window");
    expect(await rowsOf(act)).toEqual([]);
  });

  test("a version that cannot apply is no neighbour at ingest", async () => {
    const act = "2020/97";
    const reported = spyOn(logger, "error");
    try {
      await store(
        version({
          act,
          validFrom: "2020-01-01",
          end: { type: "exclusive", on: "2021-01-01" },
        }),
      );
      // Opens the day after its predecessor closes, which between two
      // versions that apply is an inclusive end passed through unshifted.
      await store({
        ...version({ act, validFrom: "2021-01-02" }),
        version: {
          type: "invalid-window",
          validFrom: "2021-01-02",
          end: { type: "last-day-in-force", on: "2020-12-31" },
          basis: "reversed",
        },
      });

      expect(reported).not.toHaveBeenCalled();
      expect(await rowsOf(act)).toHaveLength(2);
    } finally {
      reported.mockRestore();
    }
  });

  test("a live listing lifts only a withdrawal for being unlisted; a snapshot, a replay or an unstated origin lifts none", async () => {
    const origins = [
      "live",
      "bulk-snapshot",
      "stored-raw-replay",
      undefined,
    ] as const;
    const bases = [
      "publisher-unlisted",
      "listed-not-stored",
      "deferred-promulgated",
    ] as const;
    const outcomes: Record<string, string> = {};
    let act = 0;
    for (const basis of bases) {
      for (const origin of origins) {
        act += 1;
        const input = version({ act: `2031/${act}`, validFrom: "2031-01-01" });
        const stored = await store(input);
        await db
          .update(legislationDocuments)
          .set({
            windowDisposition: "withdrawn",
            windowDispositionBasis: basis,
          })
          .where(eq(legislationDocuments.id, stored.id));

        // The same content: only the observation's origin varies.
        await store({ ...input, origin });
        const [after] = await rowsOf(`2031/${act}`);
        outcomes[`${basis} ${origin ?? "unstated"}`] =
          `${after?.disposition ?? "missing"} ${after?.basis ?? ""}`.trim();
      }
    }

    expect(outcomes).toEqual({
      "publisher-unlisted live": "effective",
      "publisher-unlisted bulk-snapshot": "withdrawn publisher-unlisted",
      "publisher-unlisted stored-raw-replay": "withdrawn publisher-unlisted",
      "publisher-unlisted unstated": "withdrawn publisher-unlisted",
      "listed-not-stored live": "effective",
      "listed-not-stored bulk-snapshot": "withdrawn listed-not-stored",
      "listed-not-stored stored-raw-replay": "withdrawn listed-not-stored",
      "listed-not-stored unstated": "withdrawn listed-not-stored",
      "deferred-promulgated live": "withdrawn deferred-promulgated",
      "deferred-promulgated bulk-snapshot": "withdrawn deferred-promulgated",
      "deferred-promulgated stored-raw-replay":
        "withdrawn deferred-promulgated",
      "deferred-promulgated unstated": "withdrawn deferred-promulgated",
    });
  });

  test("a withdrawal committed between the writer's read and its write is kept", async () => {
    const act = "2021/98";
    const input = version({ act, validFrom: "2021-06-01" });
    const stored = await store(input);
    const revised = { ...input, title: "Revised", origin: "live" } as const;
    // The census commits right after the writer's lookup, before its write.
    let calls = 0;
    const interleaved: ScopedDb = async (fn) => {
      const result = await scopedDb(fn);
      calls += 1;
      if (calls === 1) {
        await db
          .update(legislationDocuments)
          .set({
            windowDisposition: "withdrawn",
            windowDispositionBasis: "deferred-promulgated",
          })
          .where(eq(legislationDocuments.id, stored.id));
      }
      return result;
    };

    const written = await store(revised, interleaved);
    const replayed = await store(revised);

    expect(written).toMatchObject({ id: stored.id, skipped: false });
    // The payload is refreshed, the withdrawal kept, and the hash is the one
    // the kept classification gives, so the next pass is a fixed point.
    expect(await rowsOf(act)).toEqual([
      expect.objectContaining({
        title: "Revised",
        disposition: "withdrawn",
        basis: "deferred-promulgated",
      }),
    ]);
    expect(replayed).toMatchObject({ id: stored.id, skipped: true });
  });

  test("a typed version on a key another version holds fails loudly and changes nothing", async () => {
    // Until the version-window keys are retired, a start is still a key: the
    // version replaced the day it opened shares its start with its successor,
    // and a work holds one version without a start.
    const uniqueViolation = async (input: LegislationDocumentInput) => {
      const error = await store(input).then(
        () => null,
        (error: unknown) => error,
      );
      let cause: unknown = error;
      while (isRecord(cause) && typeof cause["code"] !== "string") {
        cause = cause["cause"];
      }
      return isRecord(cause) ? cause["code"] : error;
    };
    const act = "2022/99";
    await store(version({ act, validFrom: "2023-01-01" }));
    await store({
      ...version({ act, validFrom: "2000-01-01", iri: iriOf(act, "a") }),
      version: {
        type: "never-in-force",
        validFrom: null,
        end: { type: "open" },
        basis: "publisher-flag",
      },
    });
    const before = await rowsOf(act);

    const replacedSameDay = await uniqueViolation({
      ...version({ act, validFrom: "2023-01-01", iri: iriOf(act, "b") }),
      version: {
        type: "never-in-force",
        validFrom: "2023-01-01",
        end: { type: "last-day-in-force", on: "2022-12-31" },
        basis: "replaced-same-day",
      },
    });
    const secondWithoutStart = await uniqueViolation({
      ...version({ act, validFrom: "2000-01-01", iri: iriOf(act, "c") }),
      version: {
        type: "invalid-window",
        validFrom: null,
        end: { type: "open" },
        basis: "missing-start",
      },
    });

    expect(before).toHaveLength(2);
    expect([replacedSameDay, secondWithoutStart]).toEqual(["23505", "23505"]);
    expect(await rowsOf(act)).toEqual(before);
  });

  // Last: it retires the version-window key the other tests still rely on,
  // as the later cutover does.
  test("same-start siblings are two rows once the window key is retired", async () => {
    await db.execute(
      sql`DROP INDEX legislation_documents_eli_version_lang_idx`,
    );
    const act = "2012/89-siblings";
    const consolidation = version({ act, validFrom: "2014-01-01" });
    const promulgated = version({
      act,
      validFrom: "2014-01-01",
      iri: iriOf(act, "0000-00-00"),
      title: "As promulgated",
    });

    const [a, b] = [await store(consolidation), await store(promulgated)];
    // Each re-ingest lands on its own row, never the other one.
    const [a2, b2] = [
      await store({ ...consolidation, title: "Consolidated, revised" }),
      await store({ ...promulgated, title: "As promulgated, revised" }),
    ];

    expect(a.id).not.toBe(b.id);
    expect([a2.id, b2.id]).toEqual([a.id, b.id]);
    const rows = await rowsOf(act);
    const titleOf = new Map(rows.map(({ id, title }) => [id, title]));
    expect(rows).toHaveLength(2);
    expect(titleOf.get(a.id)).toBe("Consolidated, revised");
    expect(titleOf.get(b.id)).toBe("As promulgated, revised");
  });
});
