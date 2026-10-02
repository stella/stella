import { panic, Result } from "better-result";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
  corpusIndexGroupWithdrawals,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveCorpusIndexGroupContract } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
  CorpusIndexGroupNotReadyError,
  CorpusIndexGroupWithdrawalRefusedError,
  readCorpusIndexGroupReadinessTx,
  readServingCorpusIndexTargetTx,
  unattestedCorpusIndexIdsTx,
  withdrawCorpusIndexGroupEnrollmentTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_APPEND_CANCEL_REASON } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendBatchTx,
  startCorpusProjectionAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const USA = { manifest: MANIFEST, indexGroup: "usa" } as const;
const USA_CONTRACT = resolveCorpusIndexGroupContract(USA);
const USA_DIGEST =
  USA_CONTRACT.type === "court_partition_v1"
    ? USA_CONTRACT.effectiveDigest
    : "usa is not under its own contract";
const ATTEST_USA = { ...USA, effectiveDigest: USA_DIGEST } as const;
const WITHDRAWN_BY = {
  actor: "service:corpus-index-group-provision@test",
  reason: "physical index configuration drift at $.doc_mapping",
} as const;
const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000301",
);
const USA_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000302",
);
const CZE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000303",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let seededSnapshot: Blob;

const inTx = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

const readiness = async () =>
  await inTx(
    async (tx) => await readCorpusIndexGroupReadinessTx(tx, USA_CONTRACT),
  );

/**
 * What `promise` rejects with, or null when it resolves. bun-types declares
 * `.rejects.toThrow` as void, so awaiting it trips type-aware lint.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => null,
    (error: unknown) => error,
  );

beforeAll(async () => {
  await using template = await createTestPglite();
  const templateDb = drizzle({ client: template });
  await templateDb.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: MANIFEST.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "serving",
  });
  seededSnapshot = await template.dumpDataDir();
});

beforeEach(async () => {
  client = await createTestPglite(seededSnapshot);
  db = drizzle({ client });
});

afterEach(async () => {
  await client.close();
});

test("binding converges, attestation is separate, and neither overwrites a bound contract", async () => {
  expect(await readiness()).toEqual({ type: "unready", reason: "unbound" });

  const first = await inTx(
    async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA),
  );
  const replay = await inTx(
    async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA),
  );
  expect(replay).toEqual(first);
  expect(first).toMatchObject({
    physicalIndexId: "case_law_v7_usa",
    contractVersion: "court_partition_v1",
    effectiveDigest: USA_DIGEST,
    provisioningStatus: "pending",
    attestedAt: null,
  });
  expect(await readiness()).toEqual({ type: "unready", reason: "pending" });

  // Only the declared contract can be attested.
  expect(
    await rejectionOf(
      inTx(
        async (tx) =>
          await attestCorpusIndexGroupEnrollmentTx(tx, {
            ...USA,
            effectiveDigest: "0".repeat(64),
          }),
      ),
    ),
  ).toMatchObject({ message: expect.stringContaining("not the declared one") });
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  // A replayed attestation converges.
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await readiness()).toEqual({ type: "attested" });

  // A row bound to another digest is never rebound or read as ready.
  await db
    .update(corpusIndexGroupEnrollments)
    .set({ effectiveDigest: "f".repeat(64) })
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "usa"));
  expect(await readiness()).toEqual({
    type: "unready",
    reason: "contract_mismatch",
  });
  expect(
    await rejectionOf(
      inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA)),
    ),
  ).toMatchObject({
    message: expect.stringContaining("bound to another contract"),
  });
});

test("a group under its manifest's contract is never enrolled and never waits", async () => {
  const cze = { manifest: MANIFEST, indexGroup: "cs_sk" } as const;
  expect(
    await rejectionOf(
      inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, cze)),
    ),
  ).toMatchObject({
    message: expect.stringContaining("not one the registry records"),
  });
  expect(
    await inTx(
      async (tx) =>
        await readCorpusIndexGroupReadinessTx(
          tx,
          resolveCorpusIndexGroupContract(cze),
        ),
    ),
  ).toEqual({ type: "base" });
  expect(
    await inTx(
      async (tx) =>
        await unattestedCorpusIndexIdsTx(
          tx,
          CORPUS_INDEX_MANIFESTS.legislation_v2,
        ),
    ),
  ).toEqual([]);
});

test("a scoped read of a group refuses until it is attested; other reads never wait on it", async () => {
  const read = async (jurisdiction: string | undefined) =>
    await inTx(
      async (tx) =>
        await readServingCorpusIndexTargetTx(tx, {
          family: "case_law",
          jurisdiction,
        }),
    );
  const target = async (jurisdiction: string | undefined) => {
    const served = await read(jurisdiction);
    return Result.isOk(served)
      ? served.value
      : panic(`Refused: ${served.error.message}`);
  };
  const refusal = async (jurisdiction: string | undefined) => {
    const served = await read(jurisdiction);
    return Result.isError(served) ? served.error : null;
  };
  expect(await refusal("USA")).toBeInstanceOf(CorpusIndexGroupNotReadyError);
  // A scoped base read keeps its route and its legacy cursor form.
  expect(await target("CZE")).toMatchObject({
    contract: { type: "base" },
    route: { indexId: "case_law_v7_cs_sk", jurisdictionClause: "CZE" },
    cursorTarget: null,
  });

  // A global read before attestation names the created base groups exactly,
  // bridges HUN (declared later, not enrolled) through its own pattern, and
  // never names the unattested USA index, which may already hold documents.
  const unattestedGlobal = await target(undefined);
  expect(unattestedGlobal.contract).toBeNull();
  expect(unattestedGlobal.route.indexId).toBe(
    "case_law_v7_aut,case_law_v7_cs_sk,case_law_v7_eu,case_law_v7_hun*,case_law_v7_pol",
  );
  expect(unattestedGlobal.cursorTarget).toMatch(/^[0-9a-f]{32}$/u);

  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  expect(await refusal("USA")).toBeInstanceOf(CorpusIndexGroupNotReadyError);
  expect((await target(undefined)).route).toEqual(unattestedGlobal.route);
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  const scoped = await target("USA");
  expect(scoped.contract).toBe(USA_CONTRACT);
  expect(scoped.route.indexId).toBe("case_law_v7_usa");
  expect(scoped.cursorTarget).toMatch(/^[0-9a-f]{32}$/u);

  // Once attested the global read names the index exactly, and its cursors
  // bind the set it reached, so a base-only cursor cannot continue it.
  const attestedGlobal = await target(undefined);
  expect(attestedGlobal.route.indexId).toBe(
    `${unattestedGlobal.route.indexId},case_law_v7_usa`,
  );
  expect(attestedGlobal.cursorTarget).toMatch(/^[0-9a-f]{32}$/u);
  expect(attestedGlobal.cursorTarget).not.toBe(scoped.cursorTarget);

  // Withdrawn again, the global read drops it at once.
  await db
    .update(corpusIndexGroupEnrollments)
    .set({ provisioningStatus: "pending", attestedAt: null })
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "usa"));
  expect(await target(undefined)).toMatchObject({
    route: unattestedGlobal.route,
    cursorTarget: unattestedGlobal.cursorTarget,
  });

  // A group declared after the generation was built: bridged until it has an
  // enrollment row, then reached by exact id only while attested. Its scoped
  // reads never wait on any of that.
  const hun = { manifest: MANIFEST, indexGroup: "hun" } as const;
  expect((await target("HUN")).route.indexId).toBe("case_law_v7_hun");
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, hun));
  const hunPending = await target(undefined);
  expect(hunPending.route.indexId).toBe(
    "case_law_v7_aut,case_law_v7_cs_sk,case_law_v7_eu,case_law_v7_pol",
  );
  expect(hunPending.cursorTarget).not.toBe(unattestedGlobal.cursorTarget);
  expect((await target("HUN")).route.indexId).toBe("case_law_v7_hun");
  await inTx(
    async (tx) =>
      await attestCorpusIndexGroupEnrollmentTx(tx, {
        ...hun,
        effectiveDigest: corpusIndexManifestDigest(MANIFEST),
      }),
  );
  const withHun = await target(undefined);
  expect(withHun.route.indexId).toBe(
    "case_law_v7_aut,case_law_v7_cs_sk,case_law_v7_eu,case_law_v7_hun,case_law_v7_pol",
  );
  expect(withHun.cursorTarget).not.toBe(unattestedGlobal.cursorTarget);
});

test("an attestation withdrawn after reservation stops the append at start, and the work waits for the next one", async () => {
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "group-enrollment",
    name: "Group enrollment",
  });
  await db.insert(caseLawDecisions).values({
    id: USA_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "No. 19-1392",
    court: "Supreme Court of the United States",
    courtId: "scotus",
    country: "USA",
    language: "en",
    contentHash: "a".repeat(64),
  });
  await inTx(
    async (tx) =>
      await advanceCorpusProjectionDesiredStateTx(tx, {
        family: "case_law",
        entityId: USA_DECISION_ID,
      }),
  );
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  const withdraw = async () =>
    await inTx(
      async (tx) =>
        await withdrawCorpusIndexGroupEnrollmentTx(tx, {
          ...USA,
          ...WITHDRAWN_BY,
        }),
    );
  const reserve = async () =>
    await inTx(
      async (tx) =>
        await reserveCorpusProjectionIntentsTx(tx, {
          family: "case_law",
          generation: MANIFEST.generation,
          scope: { type: "route", indexId: "case_law_v7_usa" },
          limit: 1,
          leaseMs: 60_000,
        }),
    );
  const lastErrorOf = async (intentId: SafeId<"corpusIndexProjectionIntent">) =>
    await db
      .select({
        status: corpusIndexProjectionIntents.status,
        lastError: corpusIndexProjectionIntents.lastError,
      })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, intentId));

  // The batch start, which the append cycle uses.
  const batchLeases = await reserve();
  expect(batchLeases).toHaveLength(1);
  await withdraw();
  expect(
    await inTx(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(tx, { leases: batchLeases }),
    ),
  ).toEqual(
    batchLeases.map(({ intentId }) => ({
      intentId,
      status: "stale_cancelled",
    })),
  );
  const [batchLease] = batchLeases;
  if (batchLease === undefined) {
    throw new Error("the batch start reserved nothing");
  }
  expect(await lastErrorOf(batchLease.intentId)).toEqual([
    {
      status: "cancelled",
      lastError: CORPUS_INDEX_APPEND_CANCEL_REASON.groupNotAttested,
    },
  ]);
  // The desired state still needs work; nothing reserves it while unattested.
  expect(await reserve()).toEqual([]);

  // The single start: attested again, reserved, withdrawn, refused.
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  const [single] = await reserve();
  if (single === undefined) {
    throw new Error("the attested group's work was not reserved again");
  }
  await withdraw();
  expect(
    await inTx(
      async (tx) =>
        await startCorpusProjectionAppendTx(tx, {
          intentId: single.intentId,
          leaseToken: single.leaseToken,
        }),
    ),
  ).toBe("stale_cancelled");
  expect(await lastErrorOf(single.intentId)).toEqual([
    {
      status: "cancelled",
      lastError: CORPUS_INDEX_APPEND_CANCEL_REASON.groupNotAttested,
    },
  ]);

  // Attested, the same work starts.
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  const started = await reserve();
  expect(
    await inTx(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(tx, { leases: started }),
    ),
  ).toEqual(started.map(({ intentId }) => ({ intentId, status: "started" })));
});

test("no append reaches a group before its attestation, and its work waits rather than fails", async () => {
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "group-enrollment",
    name: "Group enrollment",
  });
  await db.insert(caseLawDecisions).values([
    {
      id: USA_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "No. 19-1392",
      court: "Supreme Court of the United States",
      courtId: "scotus",
      country: "USA",
      language: "en",
      contentHash: "a".repeat(64),
    },
    {
      id: CZE_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "4 As 3/2008",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "b".repeat(64),
    },
  ]);
  for (const entityId of [USA_DECISION_ID, CZE_DECISION_ID]) {
    await inTx(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(tx, {
          family: "case_law",
          entityId,
        }),
    );
  }
  expect(
    await db
      .select({
        entityId: corpusIndexProjectionStates.entityId,
        indexId: corpusIndexProjectionStates.desiredIndexId,
      })
      .from(corpusIndexProjectionStates)
      .orderBy(corpusIndexProjectionStates.entityId),
  ).toEqual([
    { entityId: USA_DECISION_ID, indexId: "case_law_v7_usa" },
    { entityId: CZE_DECISION_ID, indexId: "case_law_v7_cs_sk" },
  ]);

  const reserve = async () =>
    (
      await inTx(
        async (tx) =>
          await reserveCorpusProjectionIntentsTx(tx, {
            family: "case_law",
            generation: MANIFEST.generation,
            limit: 10,
            leaseMs: 60_000,
          }),
      )
    ).map(({ entityId }) => entityId);
  const reserveRoute = async (indexId: string) =>
    await inTx(
      async (tx) =>
        await reserveCorpusProjectionIntentsTx(tx, {
          family: "case_law",
          generation: MANIFEST.generation,
          scope: { type: "route", indexId },
          limit: 10,
          leaseMs: 60_000,
        }),
    );

  expect(await reserve()).toEqual([CZE_DECISION_ID]);
  expect(await reserveRoute("case_law_v7_usa")).toEqual([]);
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  expect(await reserve()).toEqual([]);
  expect(
    await db
      .select({ status: corpusIndexProjectionStates.workStatus })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, USA_DECISION_ID)),
  ).toEqual([{ status: "eligible" }]);

  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await reserve()).toEqual([USA_DECISION_ID]);
  expect(
    await db
      .select({ indexId: corpusIndexProjectionIntents.indexId })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.entityId, USA_DECISION_ID)),
  ).toEqual([{ indexId: "case_law_v7_usa" }]);
});

test("a withdrawn attestation makes the group unready until attested again", async () => {
  const hun = { manifest: MANIFEST, indexGroup: "hun" } as const;
  const withdraw = async (target: {
    manifest: typeof MANIFEST;
    indexGroup: string;
  }) =>
    await inTx(
      async (tx) =>
        await withdrawCorpusIndexGroupEnrollmentTx(tx, {
          ...target,
          ...WITHDRAWN_BY,
        }),
    );
  const read = async (jurisdiction: string | undefined) =>
    await inTx(
      async (tx) =>
        await readServingCorpusIndexTargetTx(tx, {
          family: "case_law",
          jurisdiction,
        }),
    );
  const target = async (jurisdiction: string | undefined) => {
    const served = await read(jurisdiction);
    return Result.isOk(served)
      ? served.value
      : panic(`Refused: ${served.error.message}`);
  };
  const refusedRead = async (jurisdiction: string) => {
    const served = await read(jurisdiction);
    return Result.isError(served) ? served.error : null;
  };
  const globalIndexes = async () => (await target(undefined)).route.indexId;

  // Nothing to withdraw before a binding or an attestation.
  expect(await withdraw(USA)).toBe(false);
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  expect(await withdraw(USA)).toBe(false);
  expect(await readiness()).toEqual({ type: "unready", reason: "pending" });

  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await readiness()).toEqual({ type: "attested" });
  expect((await target("USA")).route.indexId).toBe("case_law_v7_usa");
  expect(await globalIndexes()).toContain("case_law_v7_usa");
  expect(await withdraw(USA)).toBe(true);
  expect(await readiness()).toEqual({ type: "unready", reason: "pending" });
  // Out of service: scoped reads refuse, generation-wide reads leave it out,
  // and it is among the indexes no append may start on.
  expect(await refusedRead("USA")).toMatchObject({
    indexId: "case_law_v7_usa",
    reason: "pending",
  });
  expect(await globalIndexes()).not.toContain("case_law_v7_usa");
  expect(
    await inTx(async (tx) => await unattestedCorpusIndexIdsTx(tx, MANIFEST)),
  ).toEqual(["case_law_v7_usa"]);
  const [row] = await db
    .select()
    .from(corpusIndexGroupEnrollments)
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "usa"));
  expect(row).toMatchObject({
    effectiveDigest: USA_DIGEST,
    provisioningStatus: "pending",
    attestedAt: null,
  });
  expect(await withdraw(USA)).toBe(false);

  // Only the call that changed the row is on the trail, with who and why.
  expect(
    await db
      .select({
        family: corpusIndexGroupWithdrawals.family,
        generation: corpusIndexGroupWithdrawals.generation,
        indexGroup: corpusIndexGroupWithdrawals.indexGroup,
        effectiveDigest: corpusIndexGroupWithdrawals.effectiveDigest,
        actor: corpusIndexGroupWithdrawals.actor,
        reason: corpusIndexGroupWithdrawals.reason,
      })
      .from(corpusIndexGroupWithdrawals),
  ).toEqual([
    {
      family: "case_law",
      generation: "case_law_v7",
      indexGroup: "usa",
      effectiveDigest: USA_DIGEST,
      ...WITHDRAWN_BY,
    },
  ]);
  // A withdrawal names who and why, or does not happen.
  for (const by of [
    { actor: "", reason: WITHDRAWN_BY.reason },
    { actor: "Operator With Spaces", reason: WITHDRAWN_BY.reason },
    { actor: WITHDRAWN_BY.actor, reason: "   " },
  ]) {
    expect(
      await rejectionOf(
        inTx(
          async (tx) =>
            await withdrawCorpusIndexGroupEnrollmentTx(tx, { ...USA, ...by }),
        ),
      ),
    ).toBeInstanceOf(Error);
  }

  // The binding survives, so attesting the same contract again converges.
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await readiness()).toEqual({ type: "attested" });

  // A later-declared base group is read by scope and appended to without the
  // registry, so its withdrawal is refused rather than reported as done.
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, hun));
  await inTx(
    async (tx) =>
      await attestCorpusIndexGroupEnrollmentTx(tx, {
        ...hun,
        effectiveDigest: corpusIndexManifestDigest(MANIFEST),
      }),
  );
  const refusal = await rejectionOf(withdraw(hun));
  expect(refusal).toMatchObject({
    message: expect.stringContaining("cannot be withdrawn"),
  });
  expect(refusal instanceof Error ? refusal.cause : undefined).toBeInstanceOf(
    CorpusIndexGroupWithdrawalRefusedError,
  );
  const [hunRow] = await db
    .select()
    .from(corpusIndexGroupEnrollments)
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "hun"));
  expect(hunRow?.provisioningStatus).toBe("attested");
  expect(
    await db
      .select({ indexGroup: corpusIndexGroupWithdrawals.indexGroup })
      .from(corpusIndexGroupWithdrawals),
  ).toEqual([{ indexGroup: "usa" }]);
  expect(await globalIndexes()).toContain("case_law_v7_hun");
  expect((await target("HUN")).route.indexId).toBe("case_law_v7_hun");

  const cze = { manifest: MANIFEST, indexGroup: "cs_sk" } as const;
  expect(await rejectionOf(withdraw(cze))).toMatchObject({
    message: expect.stringContaining("not one the registry records"),
  });
});

test("a withdrawal records the contract the row was attested against", async () => {
  const earlierDigest = "0".repeat(64);
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  // Attested under an earlier contract; the declared contract moved since.
  await db
    .update(corpusIndexGroupEnrollments)
    .set({ effectiveDigest: earlierDigest })
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "usa"));
  expect(await readiness()).toEqual({
    type: "unready",
    reason: "contract_mismatch",
  });

  expect(
    await inTx(
      async (tx) =>
        await withdrawCorpusIndexGroupEnrollmentTx(tx, {
          ...USA,
          ...WITHDRAWN_BY,
        }),
    ),
  ).toBe(true);
  expect(
    await db
      .select({ effectiveDigest: corpusIndexGroupWithdrawals.effectiveDigest })
      .from(corpusIndexGroupWithdrawals),
  ).toEqual([{ effectiveDigest: earlierDigest }]);
});

test("a generation's enrollments leave with its registration", async () => {
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  await db.delete(corpusIndexGenerations).where(sql`true`);
  expect(await db.select().from(corpusIndexGroupEnrollments)).toEqual([]);
});
