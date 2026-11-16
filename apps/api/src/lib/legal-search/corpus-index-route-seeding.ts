/**
 * Whether every route (physical index) of a corpus generation is seeded: each
 * canonical row the route holds has a desired state in the generation.
 *
 * Seeding is filled by one walk over the whole generation in id order
 * (`corpus_index_generation_seeding_passes`), since a per-route walk would
 * read the whole corpus once per route: case-law decisions have no index on
 * (country, id). A pass records the routes and the jurisdictions routed as
 * it begins, and when it completes it marks exactly those routes seeded
 * (`corpus_index_route_seedings`). A route that did not exist when the pass
 * began has no row and stays unseeded until a pass that saw it completes, so
 * a group declared later (decisions routable with no canonical write, which
 * no writer would seed) is never inherited silently.
 *
 * Why the fact stays true after the pass: every desired writer projects a
 * changed row into every active generation in the writing transaction
 * (`corpus-index-projection-desired-state.ts`; the test databases check it at
 * commit, `tests/helpers/corpus-projection-seeding-guard.ts`). Rows created
 * after the walk passed their id are seeded by their writer; rows created
 * before are walked. A generation that leaves the active set stops receiving
 * those writes, so the transition that takes it out deletes its pass
 * (`corpus-index-generation-store.ts`), and the route rows cascade.
 *
 * Each page seeds and records its cursor and counts in one transaction, so
 * the pass row never claims more than was seeded.
 */
import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { compareCodeUnit } from "@stll/collation";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerationSeedingPasses,
  corpusIndexRouteSeedings,
  legislationDocuments,
} from "@/api/db/schema";
import {
  lockCorpusIndexGenerationSeedingPass,
  lockCorpusIndexGenerationShared,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  type CorpusFamily,
  isActiveCorpusIndexGenerationStatus,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { requireRegisteredCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexIdFromManifest,
  type CorpusIndexManifest,
  corpusIndexManifestCoversJurisdiction,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

export type CorpusIndexSeedingTarget = {
  family: CorpusFamily;
  generation: string;
};

/** Where a generation's seeding pass stands. */
export type CorpusIndexSeedingPass = {
  number: number;
  startedAt: Date;
  routes: readonly string[];
  afterEntityId: string | null;
  walked: number;
  seeded: number;
  completedAt: Date | null;
};

/** One route of a generation and whether a completed pass covered it. */
export type CorpusIndexRouteSeeding =
  | {
      indexId: string;
      jurisdictions: readonly string[];
      state: "seeded";
      passNumber: number;
      seededAt: Date;
    }
  | {
      indexId: string;
      jurisdictions: readonly string[];
      state: "unseeded";
      /**
       * `never_walked`: no completed pass saw the route. `jurisdiction_added`:
       * one did, but a jurisdiction routed to it now was not routed then.
       */
      reason: "never_walked" | "jurisdiction_added";
    };

export type CorpusIndexSeedingAdvance =
  /** The page seeded what it found; the pass goes on. */
  | {
      type: "advanced";
      pass: CorpusIndexSeedingPass;
      walked: number;
      seeded: number;
    }
  /** This call walked the last page and marked the pass's routes seeded. */
  | { type: "completed"; pass: CorpusIndexSeedingPass }
  /** Every route the generation has now is seeded; nothing to walk. */
  | { type: "complete"; pass: CorpusIndexSeedingPass }
  /** Another transaction holds the next row; nothing moved. */
  | { type: "busy"; pass: CorpusIndexSeedingPass }
  /** The generation does not take every change, so it cannot be seeded. */
  | { type: "inactive"; status: string | null };

/**
 * More distinct legislation jurisdictions than any deployment holds; the
 * read fails rather than truncating the route set.
 */
const LEGISLATION_JURISDICTION_CAP = 500;

const passes = corpusIndexGenerationSeedingPasses;
const routeSeedings = corpusIndexRouteSeedings;

/**
 * The jurisdictions a generation routes now. Case law routes the declared
 * jurisdictions its manifest covers, so its routes are code. Legislation
 * routes every jurisdiction its documents carry, so its routes are data: a
 * loose scan of the country index reads one entry per jurisdiction.
 */
const routedJurisdictionsTx = async (
  tx: Transaction,
  manifest: CorpusIndexManifest,
): Promise<string[]> => {
  switch (manifest.family) {
    case "case_law":
      return CASE_LAW_JURISDICTIONS.filter((jurisdiction) =>
        corpusIndexManifestCoversJurisdiction(manifest, jurisdiction),
      );
    case "legislation": {
      const country = legislationDocuments.country;
      const rows = executedRows(
        await tx.execute(sql`
          WITH RECURSIVE countries(country) AS (
            (SELECT ${country} FROM ${legislationDocuments} ORDER BY ${country} LIMIT 1)
            UNION ALL
            SELECT (
              SELECT ${country} FROM ${legislationDocuments}
              WHERE ${country} > countries.country
              ORDER BY ${country} LIMIT 1
            )
            FROM countries
            WHERE countries.country IS NOT NULL
          )
          SELECT country FROM countries WHERE country IS NOT NULL
          LIMIT ${LEGISLATION_JURISDICTION_CAP + 1}
        `),
      ).map((row) =>
        isRecord(row) && typeof row["country"] === "string"
          ? row["country"]
          : panic("Malformed legislation jurisdiction row"),
      );
      return rows.length > LEGISLATION_JURISDICTION_CAP
        ? panic(
            `Legislation holds more than ${LEGISLATION_JURISDICTION_CAP} jurisdictions`,
          )
        : rows;
    }
    default:
      manifest satisfies never;
      return panic(`Unhandled manifest: ${String(manifest)}`);
  }
};

/** Each route of the generation with the jurisdictions it holds, by index id. */
const routesOf = (
  manifest: CorpusIndexManifest,
  jurisdictions: readonly string[],
): Map<string, string[]> => {
  const routes = new Map<string, string[]>();
  for (const jurisdiction of jurisdictions) {
    const indexId = corpusIndexIdFromManifest(manifest, jurisdiction);
    routes.set(indexId, [...(routes.get(indexId) ?? []), jurisdiction]);
  }
  return routes;
};

type PassRow = typeof passes.$inferSelect;

const passView = (row: PassRow): CorpusIndexSeedingPass => ({
  number: row.passNumber,
  startedAt: row.passStartedAt,
  routes: row.routeIndexIds,
  afterEntityId: row.afterEntityId,
  walked: row.walkedCount,
  seeded: row.seededCount,
  completedAt: row.completedAt,
});

const isTarget = ({ family, generation }: CorpusIndexSeedingTarget) =>
  and(eq(passes.family, family), eq(passes.generation, generation));

/**
 * The registry row, share-locked: every status transition locks it for
 * update first, so the generation cannot leave the active set (and delete
 * its pass) while this transaction seeds it.
 */
const lockActiveManifestTx = async (
  tx: Transaction,
  { family, generation }: CorpusIndexSeedingTarget,
): Promise<
  | { type: "active"; manifest: CorpusIndexManifest }
  | { type: "inactive"; status: string | null }
> => {
  const row = await lockCorpusIndexGenerationShared(tx, {
    family,
    generation,
  });
  if (row === undefined || !isActiveCorpusIndexGenerationStatus(row.status)) {
    return { type: "inactive", status: row?.status ?? null };
  }
  return {
    type: "active",
    manifest: requireRegisteredCorpusIndexManifest(row),
  };
};

/** Route rows one generation may hold: more than either family routes. */
const ROUTE_SEEDING_READ_CAP = 1000;

const readRouteRowsTx = async (
  tx: Transaction,
  { family, generation }: CorpusIndexSeedingTarget,
) => {
  const read = await readBounded(
    tx
      .select()
      .from(routeSeedings)
      .where(
        and(
          eq(routeSeedings.family, family),
          eq(routeSeedings.generation, generation),
        ),
      )
      .orderBy(routeSeedings.indexId),
    ROUTE_SEEDING_READ_CAP,
  );
  return read.type === "overflow"
    ? panic(`Route seedings of ${family}/${generation} exceed their routes`)
    : read.rows;
};

const judgeRoutes = (
  routes: ReadonlyMap<string, readonly string[]>,
  rows: readonly (typeof routeSeedings.$inferSelect)[],
): CorpusIndexRouteSeeding[] => {
  const byIndex = new Map(rows.map((row) => [row.indexId, row]));
  return (
    [...routes.entries()]
      // Index ids are ASCII identifiers, so code-unit order is their order.
      .toSorted(([left], [right]) => compareCodeUnit(left, right))
      .map(([indexId, jurisdictions]): CorpusIndexRouteSeeding => {
        const row = byIndex.get(indexId);
        if (row === undefined) {
          return {
            indexId,
            jurisdictions,
            state: "unseeded",
            reason: "never_walked",
          };
        }
        const covered = new Set(row.jurisdictions);
        return jurisdictions.every((jurisdiction) => covered.has(jurisdiction))
          ? {
              indexId,
              jurisdictions,
              state: "seeded",
              passNumber: row.passNumber,
              seededAt: row.seededAt,
            }
          : {
              indexId,
              jurisdictions,
              state: "unseeded",
              reason: "jurisdiction_added",
            };
      })
  );
};

/**
 * Every route the generation has now, and whether a completed pass covered
 * it. Null when the generation is not active: its seeding is not kept.
 */
export const readCorpusIndexRouteSeedingsTx = async (
  tx: Transaction,
  target: CorpusIndexSeedingTarget,
): Promise<{
  pass: CorpusIndexSeedingPass | null;
  routes: CorpusIndexRouteSeeding[];
} | null> => {
  const active = await lockActiveManifestTx(tx, target);
  if (active.type === "inactive") {
    return null;
  }
  const routes = routesOf(
    active.manifest,
    await routedJurisdictionsTx(tx, active.manifest),
  );
  const passRow = (
    await tx.select().from(passes).where(isTarget(target)).limit(1)
  ).at(0);
  return {
    pass: passRow === undefined ? null : passView(passRow),
    routes: judgeRoutes(routes, await readRouteRowsTx(tx, target)),
  };
};

/** Begin a pass over the routes the generation has now. */
const startPassTx = async (
  tx: Transaction,
  target: CorpusIndexSeedingTarget,
  routes: ReadonlyMap<string, readonly string[]>,
  previous: PassRow | undefined,
): Promise<PassRow> => {
  const values = {
    passNumber: (previous?.passNumber ?? 0) + 1,
    passStartedAt: sql`clock_timestamp()`,
    routeIndexIds: [...routes.keys()].toSorted(),
    routeJurisdictions: [...routes.values()].flat().toSorted(),
    afterEntityId: null,
    walkedCount: 0,
    seededCount: 0,
    completedAt: null,
  };
  // audit: skip - derived public corpus seeding bookkeeping
  const started = await tx
    .insert(passes)
    .values({ ...target, ...values })
    .onConflictDoUpdate({
      target: [passes.family, passes.generation],
      set: values,
    })
    .returning();
  return started.at(0) ?? panic("Seeding pass insert returned no row");
};

/** Mark every route the pass captured seeded, in the pass's last transaction. */
const completePassTx = async (
  tx: Transaction,
  target: CorpusIndexSeedingTarget,
  manifest: CorpusIndexManifest,
  pass: PassRow,
): Promise<PassRow> => {
  // audit: skip - derived public corpus seeding bookkeeping
  const completed =
    (
      await tx
        .update(passes)
        .set({ completedAt: sql`clock_timestamp()` })
        .where(and(isTarget(target), eq(passes.passNumber, pass.passNumber)))
        .returning()
    ).at(0) ??
    panic(`Seeding pass of ${target.family}/${target.generation} lost`);
  const seededAt =
    completed.completedAt ??
    panic(
      `Seeding pass of ${target.family}/${target.generation} not completed`,
    );
  const captured = routesOf(manifest, pass.routeJurisdictions);
  const routeIds = pass.routeIndexIds.filter((indexId) =>
    captured.has(indexId),
  );
  if (routeIds.length > 0) {
    // audit: skip - derived public corpus seeding bookkeeping
    await tx
      .insert(routeSeedings)
      .values(
        routeIds.map((indexId) => ({
          ...target,
          indexId,
          jurisdictions: captured.get(indexId) ?? [],
          passNumber: pass.passNumber,
          passStartedAt: pass.passStartedAt,
          seededAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          routeSeedings.family,
          routeSeedings.generation,
          routeSeedings.indexId,
        ],
        set: {
          jurisdictions: sql`excluded.jurisdictions`,
          passNumber: sql`excluded.pass_number`,
          passStartedAt: sql`excluded.pass_started_at`,
          seededAt: sql`excluded.seeded_at`,
        },
      });
  }
  return completed;
};

/**
 * Advance the generation's seeding pass by one page of at most `limit`
 * canonical ids, seeding at most `seedLimit` of them, and record the new
 * cursor, or the pass's completion and its routes, in the same transaction.
 *
 * With no pass, or a completed pass while some route the generation has now
 * is unseeded, it begins a new pass from the first id; routes already seeded
 * stay seeded while it runs. A busy page (the next row is locked by a
 * writer) moves nothing. The pass row is locked for update, so two callers
 * never walk one pass at once.
 */
export const advanceCorpusIndexGenerationSeedingTx = async (
  tx: Transaction,
  target: CorpusIndexSeedingTarget,
  { limit, seedLimit }: { limit: number; seedLimit?: number },
): Promise<CorpusIndexSeedingAdvance> => {
  const active = await lockActiveManifestTx(tx, target);
  if (active.type === "inactive") {
    return active;
  }
  const { manifest } = active;
  const locked = await lockCorpusIndexGenerationSeedingPass(tx, target);
  let pass: PassRow;
  if (locked === undefined || locked.completedAt !== null) {
    const routes = routesOf(
      manifest,
      await routedJurisdictionsTx(tx, manifest),
    );
    if (locked !== undefined) {
      const judged = judgeRoutes(routes, await readRouteRowsTx(tx, target));
      if (judged.every(({ state }) => state === "seeded")) {
        return { type: "complete", pass: passView(locked) };
      }
    }
    pass = await startPassTx(tx, target, routes, locked);
  } else {
    pass = locked;
  }
  const after = pass.afterEntityId ?? undefined;
  const page = await bootstrapCorpusProjectionDesiredStateBatchTx(
    tx,
    target.family === "case_law"
      ? {
          family: "case_law",
          generation: target.generation,
          limit,
          ...(seedLimit === undefined ? {} : { seedLimit }),
          ...(after === undefined
            ? {}
            : { afterEntityId: brandPersistedCaseLawDecisionId(after) }),
        }
      : {
          family: "legislation",
          generation: target.generation,
          limit,
          ...(seedLimit === undefined ? {} : { seedLimit }),
          ...(after === undefined
            ? {}
            : { afterEntityId: brandPersistedLegislationDocumentId(after) }),
        },
  );
  switch (page.status) {
    case "busy":
      return { type: "busy", pass: passView(pass) };
    case "complete":
    case "range_complete":
      return {
        type: "completed",
        pass: passView(await completePassTx(tx, target, manifest, pass)),
      };
    case "advanced": {
      // audit: skip - derived public corpus seeding bookkeeping
      const moved = (
        await tx
          .update(passes)
          .set({
            afterEntityId: page.nextAfterEntityId,
            walkedCount: sql`${passes.walkedCount} + ${page.walkedCount}`,
            seededCount: sql`${passes.seededCount} + ${page.seededCount}`,
          })
          .where(and(isTarget(target), eq(passes.passNumber, pass.passNumber)))
          .returning()
      ).at(0);
      return moved === undefined
        ? panic(`Seeding pass of ${target.family}/${target.generation} lost`)
        : {
            type: "advanced",
            pass: passView(moved),
            walked: page.walkedCount,
            seeded: page.seededCount,
          };
    }
    default:
      page satisfies never;
      return panic(`Unhandled page: ${String(page)}`);
  }
};
