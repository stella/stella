import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DAY_IN_MS } from "@stll/time";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawReconciliationItems,
  caseLawSources,
  RECONCILIATION_ITEM_STATUS,
  relations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";
import {
  countReconciliationItems,
  countTerminalReconciliationItemsBySlice,
  listReconciliationItems,
  parkReconciliationItem,
  pruneUnlistedReconciliationItems,
  RECONCILIATION_RETRY_DELAYS_MS,
  refreshTrackedReconciliationItems,
  resetTerminalReconciliationItems,
  resolveReconciliationItem,
  resolveReconciliationItems,
  retireReconciliationItem,
  selectDueReconciliationItems,
} from "@/api/lib/legal-search/reconciliation-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { fingerprintReconciliationPayload } from "./reconciliation-payload";

// Real columns verify durable capped retries, identity convergence, explicit
// terminal dispositions, lease fencing and listing-revision compare-and-set.

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

const { createTestPglite } = await import("@/api/tests/pglite-test-db");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(
    async (tx) => await callback(asTestRaw<Transaction>(tx)),
  );
const LEASE_TOKEN = createSafeId<"caseLawSourceIngestionLease">();

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const seedSource = async (): Promise<SafeId<"caseLawSource">> => {
  const id = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id,
    adapterKey: `reconciliation-${id}`,
    name: "store fixture",
    ingestionLeaseToken: LEASE_TOKEN,
    ingestionLeaseExpiresAt: new Date("2100-01-01T00:00:00Z"),
  });
  return id;
};

/** A key exactly as the loop writes it, from a real publisher document id. */
const DOCUMENT_KEY =
  listingIdentityKey({
    type: "document",
    sourceDocumentId: "2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
  }) ?? "";

const DOCKET_KEY =
  listingIdentityKey({
    type: "case-number",
    caseNumber: "11 C 153/2025",
    language: "cs",
  }) ?? "";

const PAYLOAD = {
  jednaciCislo: "11 C 153/2025-38",
  soud: "Krajský soud v Brně",
  odkaz:
    "https://rozhodnuti.justice.cz/api/finaldoc/2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
};

test("lost source ownership supersedes every reconciliation mutation without changing tracked input", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-10-02T12:00:00Z");
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    sourceId,
    leaseToken: LEASE_TOKEN,
    identityKey: DOCUMENT_KEY,
    slice: SLICE,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now,
  });
  const before = await db
    .select()
    .from(caseLawReconciliationItems)
    .where(eq(caseLawReconciliationItems.sourceId, sourceId));
  await db
    .update(caseLawSources)
    .set({ ingestionLeaseToken: createSafeId<"caseLawSourceIngestionLease">() })
    .where(eq(caseLawSources.id, sourceId));
  expect(
    await parkReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      slice: SLICE,
      payload: PAYLOAD,
      errorTag: "publisher-miss",
      now,
    }),
  ).toEqual({ outcome: "superseded" });
  expect(
    await retireReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      slice: SLICE,
      payload: PAYLOAD,
      errorTag: "unkeyable",
      now,
    }),
  ).toEqual({ outcome: "superseded" });
  expect(
    await resolveReconciliationItem(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      payload: PAYLOAD,
    }),
  ).toEqual({ outcome: "superseded" });
  expect(
    await refreshTrackedReconciliationItems(scopedDb, {
      revisionOf: (payload) => payload,
      sourceId,
      leaseToken: LEASE_TOKEN,
      items: [
        {
          identityKey: DOCUMENT_KEY,
          slice: SLICE,
          payload: { corrected: true },
        },
      ],
      now,
    }),
  ).toEqual({ outcome: "superseded" });
  expect(
    await pruneUnlistedReconciliationItems(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      slice: SLICE,
      listedIdentityKeys: [],
      limit: 10,
    }),
  ).toEqual({ outcome: "superseded" });
  expect(
    await db
      .select()
      .from(caseLawReconciliationItems)
      .where(eq(caseLawReconciliationItems.sourceId, sourceId)),
  ).toEqual(before);
});

const SLICE = "2026-08-04";

const readRow = async (
  sourceId: SafeId<"caseLawSource">,
  identityKey: string,
) =>
  (
    await db
      .select()
      .from(caseLawReconciliationItems)
      .where(
        and(
          eq(caseLawReconciliationItems.sourceId, sourceId),
          eq(caseLawReconciliationItems.identityKey, identityKey),
        ),
      )
      .limit(1)
  ).at(0);

test.each(Object.values(RECONCILIATION_ITEM_STATUS))(
  "authoritative pruning removes unlisted %s items before the limit and preserves other scopes",
  async (status) => {
    const sourceId = await seedSource();
    const otherSourceId = await seedSource();
    const now = new Date("2026-08-11T09:00:00.000Z");
    const common = {
      payload: PAYLOAD,
      status,
      attempts: 6,
      nextAttemptAt: status === RECONCILIATION_ITEM_STATUS.PARKED ? now : null,
    };
    await db.insert(caseLawReconciliationItems).values([
      {
        ...common,
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice: SLICE,
        identityKey: "document:listed",
      },
      {
        ...common,
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice: SLICE,
        identityKey: "document:withdrawn-1",
      },
      {
        ...common,
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice: SLICE,
        identityKey: "document:withdrawn-2",
      },
      {
        ...common,
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId,
        slice: "2026-08-05",
        identityKey: "document:other-slice",
      },
      {
        ...common,
        id: createSafeId<"caseLawReconciliationItem">(),
        sourceId: otherSourceId,
        slice: SLICE,
        identityKey: "document:withdrawn-1",
      },
    ]);
    const retained = await readRow(sourceId, "document:listed");
    const otherSlice = await readRow(sourceId, "document:other-slice");
    const otherSource = await readRow(otherSourceId, "document:withdrawn-1");
    const input = {
      sourceId,
      leaseToken: LEASE_TOKEN,
      slice: SLICE,
      listedIdentityKeys: ["document:listed"],
      limit: 1,
    };
    for (const removed of [1, 1, 0]) {
      expect(await pruneUnlistedReconciliationItems(scopedDb, input)).toEqual({
        outcome: "pruned",
        removed,
      });
    }
    expect(await readRow(sourceId, "document:withdrawn-1")).toBeUndefined();
    expect(await readRow(sourceId, "document:withdrawn-2")).toBeUndefined();
    expect(await readRow(sourceId, "document:listed")).toEqual(retained);
    expect(await readRow(sourceId, "document:other-slice")).toEqual(otherSlice);
    expect(await readRow(otherSourceId, "document:withdrawn-1")).toEqual(
      otherSource,
    );
    expect(
      await pruneUnlistedReconciliationItems(scopedDb, {
        ...input,
        listedIdentityKeys: [],
      }),
    ).toEqual({ outcome: "pruned", removed: 1 });
    expect(await readRow(sourceId, "document:listed")).toBeUndefined();
  },
);

test("repeated parks advance one row along the widening schedule", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");

  for (const [index, delayMs] of RECONCILIATION_RETRY_DELAYS_MS.entries()) {
    const parked = await parkReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      leaseToken: LEASE_TOKEN,
      sourceId,
      slice: SLICE,
      identityKey: DOCUMENT_KEY,
      payload: PAYLOAD,
      errorTag: "detail-unavailable",
      now,
    });

    expect(parked).toMatchObject({
      outcome: "recorded",
      status: RECONCILIATION_ITEM_STATUS.PARKED,
      attempts: index + 1,
    });
    const row = await readRow(sourceId, DOCUMENT_KEY);
    expect(row?.nextAttemptAt?.getTime()).toBe(now.getTime() + delayMs);
  }

  // One row throughout: the unique identity is what makes a second listing of
  // the same decision continue its attempt instead of starting a parallel one.
  expect(await countReconciliationItems(scopedDb, sourceId)).toEqual({
    parked: 1,
    terminal: 0,
  });
});

test("repeated unavailable documents stay parked past every retry boundary and recover", async () => {
  const sourceId = await seedSource();
  let now = new Date("2026-08-11T09:00:00.000Z");
  const lastDelay =
    RECONCILIATION_RETRY_DELAYS_MS.at(-1) ??
    panic("The retry schedule needs a capped delay");
  const attempts = RECONCILIATION_RETRY_DELAYS_MS.length * 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const parked = await parkReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      leaseToken: LEASE_TOKEN,
      sourceId,
      slice: SLICE,
      identityKey: DOCUMENT_KEY,
      payload: PAYLOAD,
      errorTag: attempt % 2 === 0 ? "AdapterFetchError" : "detail-unavailable",
      now,
    });
    expect(parked).toEqual({
      outcome: "recorded",
      status: RECONCILIATION_ITEM_STATUS.PARKED,
      attempts: attempt,
    });
    const row = await readRow(sourceId, DOCUMENT_KEY);
    expect(row?.lastAttemptAt).toEqual(now);
    const due =
      row?.nextAttemptAt ?? panic("Unavailable documents need a durable retry");
    expect(due.getTime()).toBeGreaterThan(now.getTime());
    expect(due.getTime() - now.getTime()).toBeLessThanOrEqual(lastDelay);
    if (attempt >= RECONCILIATION_RETRY_DELAYS_MS.length) {
      expect(due.getTime() - now.getTime()).toBe(lastDelay);
    }
    expect(
      await selectDueReconciliationItems(scopedDb, {
        sourceId,
        now,
        limit: 10,
      }),
    ).toEqual([]);
    now = due;
    expect(
      (
        await selectDueReconciliationItems(scopedDb, {
          sourceId,
          now,
          limit: 10,
        })
      ).map(({ identityKey }) => identityKey),
    ).toEqual([DOCUMENT_KEY]);
  }
  expect(await countReconciliationItems(scopedDb, sourceId)).toEqual({
    parked: 1,
    terminal: 0,
  });
  expect(
    await countTerminalReconciliationItemsBySlice(scopedDb, {
      sourceId,
      slices: [SLICE],
    }),
  ).toEqual(new Map());
  for (let replay = 0; replay < 2; replay += 1) {
    await resolveReconciliationItem(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      payload: PAYLOAD,
    });
    expect(await countReconciliationItems(scopedDb, sourceId)).toEqual({
      parked: 0,
      terminal: 0,
    });
  }
});

test("a historical terminal row is unchanged by an incidental transient failure", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  const options = {
    revisionOf: (payload: unknown) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    now,
  };
  await retireReconciliationItem(scopedDb, {
    ...options,
    errorTag: "unkeyable",
  });
  await db
    .update(caseLawReconciliationItems)
    .set({ attempts: 6, lastError: "AdapterFetchError" })
    .where(eq(caseLawReconciliationItems.sourceId, sourceId));
  const before = await readRow(sourceId, DOCUMENT_KEY);
  await parkReconciliationItem(scopedDb, {
    ...options,
    errorTag: "AdapterFetchError",
    now: new Date(now.getTime() + DAY_IN_MS),
  });
  expect(await readRow(sourceId, DOCUMENT_KEY)).toEqual(before);
});

test("an item a retry can never key is retired without serving the schedule", async () => {
  const sourceId = await seedSource();
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCKET_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now: new Date("2026-08-11T09:00:00.000Z"),
  });

  const row = await readRow(sourceId, DOCKET_KEY);
  expect(row?.status).toBe(RECONCILIATION_ITEM_STATUS.TERMINAL);
  expect(row?.attempts).toBe(1);
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCKET_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now: new Date("2026-08-12T09:00:00.000Z"),
  });
  expect(await readRow(sourceId, DOCKET_KEY)).toEqual(row);
});

test("the due read hands out only what has come due, oldest first", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");

  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now,
  });
  // A second item one step further along, so its next attempt is later.
  for (const attempt of [1, 2]) {
    expect(attempt).toBeGreaterThan(0);
    await parkReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      leaseToken: LEASE_TOKEN,
      sourceId,
      slice: SLICE,
      identityKey: DOCKET_KEY,
      payload: PAYLOAD,
      errorTag: "detail-unavailable",
      now,
    });
  }

  const firstDelayMs = RECONCILIATION_RETRY_DELAYS_MS[0];
  const beforeSecond = new Date(now.getTime() + firstDelayMs + 1000);
  expect(
    (
      await selectDueReconciliationItems(scopedDb, {
        sourceId,
        now: beforeSecond,
        limit: 10,
      })
    ).map(({ identityKey }) => identityKey),
  ).toEqual([DOCUMENT_KEY]);

  const afterBoth = new Date(
    now.getTime() + RECONCILIATION_RETRY_DELAYS_MS[1] + 1000,
  );
  expect(
    (
      await selectDueReconciliationItems(scopedDb, {
        sourceId,
        now: afterBoth,
        limit: 10,
      })
    ).map(({ identityKey }) => identityKey),
  ).toEqual([DOCUMENT_KEY, DOCKET_KEY]);
});

test("the item is forgotten once its decision is stored", async () => {
  const sourceId = await seedSource();
  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now: new Date("2026-08-11T09:00:00.000Z"),
  });

  await resolveReconciliationItem(scopedDb, {
    leaseToken: LEASE_TOKEN,
    payload: PAYLOAD,
    sourceId,
    identityKey: DOCUMENT_KEY,
  });

  expect(await readRow(sourceId, DOCUMENT_KEY)).toBeUndefined();
  expect(await countReconciliationItems(scopedDb, sourceId)).toEqual({
    parked: 0,
    terminal: 0,
  });
});

test("a reset puts retired items back into the hunt, due immediately", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now,
  });

  expect(
    await resetTerminalReconciliationItems(scopedDb, {
      sourceId,
      now,
      limit: 10,
    }),
  ).toBe(1);

  const row = await readRow(sourceId, DOCUMENT_KEY);
  expect(row?.status).toBe(RECONCILIATION_ITEM_STATUS.PARKED);
  expect(row?.attempts).toBe(0);
  expect(
    (
      await selectDueReconciliationItems(scopedDb, {
        sourceId,
        now,
        limit: 10,
      })
    ).map(({ identityKey }) => identityKey),
  ).toEqual([DOCUMENT_KEY]);
});

test("a sliced reset leaves the other slices retired", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  const otherSlice = "2026-08-05";
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now,
  });
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: otherSlice,
    identityKey: DOCKET_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now,
  });

  // The point of the narrowing: an operator who fixed one bad day re-hunts
  // that day, not every identity the adapter has ever retired.
  expect(
    await resetTerminalReconciliationItems(scopedDb, {
      sourceId,
      now,
      limit: 10,
      slice: SLICE,
    }),
  ).toBe(1);

  expect((await readRow(sourceId, DOCUMENT_KEY))?.status).toBe(
    RECONCILIATION_ITEM_STATUS.PARKED,
  );
  expect((await readRow(sourceId, DOCKET_KEY))?.status).toBe(
    RECONCILIATION_ITEM_STATUS.TERMINAL,
  );
});

test("the listing names what a source carries, in both states", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now,
  });
  await retireReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCKET_KEY,
    payload: PAYLOAD,
    errorTag: "unkeyable",
    now,
  });

  const listed = await listReconciliationItems(scopedDb, {
    sourceId,
    limit: 10,
  });

  // Identity-key order, which is what the cursor pages on: the docket key
  // sorts before the document key.
  expect(
    listed.map(({ identityKey, status, slice, lastError }) => ({
      identityKey,
      status,
      slice,
      lastError,
    })),
  ).toEqual([
    {
      identityKey: DOCKET_KEY,
      status: RECONCILIATION_ITEM_STATUS.TERMINAL,
      slice: SLICE,
      lastError: "unkeyable",
    },
    {
      identityKey: DOCUMENT_KEY,
      status: RECONCILIATION_ITEM_STATUS.PARKED,
      slice: SLICE,
      lastError: "detail-unavailable",
    },
  ]);
});

test("paging the listing reaches every item exactly once", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  for (const identityKey of [DOCKET_KEY, DOCUMENT_KEY]) {
    await parkReconciliationItem(scopedDb, {
      revisionOf: (payload) => payload,
      leaseToken: LEASE_TOKEN,
      sourceId,
      slice: SLICE,
      identityKey,
      payload: PAYLOAD,
      errorTag: "detail-unavailable",
      now,
    });
  }

  // The expectation comes from one unpaged read, not from sorting the keys
  // here: the database orders by the column's collation and this process would
  // order by UTF-16 code unit, and pinning the paged walk to the JS answer
  // would make the test assert a collation rather than the paging.
  const unpaged = (
    await listReconciliationItems(scopedDb, { sourceId, limit: 10 })
  ).map(({ identityKey }) => identityKey);
  expect(unpaged).toHaveLength(2);

  // One row per page, walked with the cursor the script prints. The property
  // that matters is the one a limit-only listing cannot give: every row is
  // reached, none twice, and the walk terminates.
  const walked: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < unpaged.length + 2; page += 1) {
    const items = await listReconciliationItems(scopedDb, {
      sourceId,
      limit: 1,
      ...(after === undefined ? {} : { after }),
    });
    if (items.length === 0) {
      break;
    }
    expect(items).toHaveLength(1);
    walked.push(...items.map(({ identityKey }) => identityKey));
    after = items.at(-1)?.identityKey;
  }

  expect(walked).toEqual(unpaged);
});

test("the listing narrows to one slice", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");
  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now,
  });
  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId,
    slice: "2026-08-05",
    identityKey: DOCKET_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now,
  });

  expect(
    (
      await listReconciliationItems(scopedDb, {
        sourceId,
        limit: 10,
        slice: SLICE,
      })
    ).map(({ identityKey }) => identityKey),
  ).toEqual([DOCUMENT_KEY]);
});

test("one source's items are invisible to another", async () => {
  const [first, second] = await Promise.all([seedSource(), seedSource()]);
  await parkReconciliationItem(scopedDb, {
    revisionOf: (payload) => payload,
    leaseToken: LEASE_TOKEN,
    sourceId: first,
    slice: SLICE,
    identityKey: DOCUMENT_KEY,
    payload: PAYLOAD,
    errorTag: "detail-unavailable",
    now: new Date("2026-08-11T09:00:00.000Z"),
  });

  expect(await countReconciliationItems(scopedDb, second)).toEqual({
    parked: 0,
    terminal: 0,
  });
});

const contentRevision = (payload: unknown) => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("content" in payload)
  ) {
    throw new TypeError("Expected content in revision fixture");
  }
  return payload.content;
};

test("position-only listing movement keeps retry state and unchanged visits do not rewrite payloads", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-10-02T12:00:00Z");
  const payload = { content: "decision", position: 1 };
  const options = {
    sourceId,
    leaseToken: LEASE_TOKEN,
    identityKey: DOCUMENT_KEY,
    slice: SLICE,
    payload,
    revisionOf: contentRevision,
    now,
    errorTag: "unkeyable" as const,
  };
  await retireReconciliationItem(scopedDb, options);
  const before =
    (await readRow(sourceId, DOCUMENT_KEY)) ??
    panic("Expected the retained coordinate fixture");
  const refresh = await refreshTrackedReconciliationItems(scopedDb, {
    sourceId,
    leaseToken: LEASE_TOKEN,
    revisionOf: contentRevision,
    now,
    items: [
      {
        identityKey: DOCUMENT_KEY,
        slice: SLICE,
        payload: { content: "decision", position: 2 },
      },
    ],
  });
  expect(refresh.outcome).toBe("refreshed");
  if (refresh.outcome === "refreshed") {
    expect(refresh.refreshedIdentityKeys.size).toBe(0);
  }
  expect(await readRow(sourceId, DOCUMENT_KEY)).toEqual({
    ...before,
    payload: { content: "decision", position: 2 },
  });
  await refreshTrackedReconciliationItems(scopedDb, {
    sourceId,
    leaseToken: LEASE_TOKEN,
    revisionOf: contentRevision,
    now,
    items: [
      {
        identityKey: DOCUMENT_KEY,
        slice: "moved",
        payload: { content: "decision", position: 2 },
      },
    ],
  });
  const moved = await readRow(sourceId, DOCUMENT_KEY);
  expect(moved?.slice).toBe("moved");
  expect(moved?.payload).toEqual({ content: "decision", position: 2 });
  expect(moved?.attempts).toBe(before.attempts);
  expect(moved?.status).toBe(before.status);
});

test("park and retire reject stale projections using the persisted hash, including legacy null hashes", async () => {
  for (const legacy of [false, true]) {
    const sourceId = await seedSource();
    const now = new Date("2026-10-02T12:00:00Z");
    const options = {
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      slice: SLICE,
      payload: { content: "current", position: 1 },
      revisionOf: contentRevision,
      now,
      errorTag: "unkeyable" as const,
    };
    await parkReconciliationItem(scopedDb, options);
    await db
      .update(caseLawReconciliationItems)
      .set(
        legacy
          ? { payloadHash: null }
          : { payload: { content: "obsolete", position: 1 } },
      )
      .where(eq(caseLawReconciliationItems.sourceId, sourceId));
    const before = await readRow(sourceId, DOCUMENT_KEY);
    const stale = { ...options, payload: { content: "obsolete", position: 2 } };
    expect(await parkReconciliationItem(scopedDb, stale)).toEqual({
      outcome: "superseded",
    });
    expect(await retireReconciliationItem(scopedDb, stale)).toEqual({
      outcome: "superseded",
    });
    expect(await readRow(sourceId, DOCUMENT_KEY)).toEqual(before);
  }
});

test("terminal corrections preserve attempts and stop reviving after two failed corrections", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-10-02T12:00:00Z");
  const options = {
    sourceId,
    leaseToken: LEASE_TOKEN,
    identityKey: DOCUMENT_KEY,
    slice: SLICE,
    payload: { content: "a" },
    revisionOf: contentRevision,
    now,
    errorTag: "unkeyable" as const,
  };
  await retireReconciliationItem(scopedDb, options);
  for (let correction = 1; correction <= 6; correction += 1) {
    const payload = { content: correction % 2 === 1 ? "b" : "a" };
    const result = await refreshTrackedReconciliationItems(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      revisionOf: contentRevision,
      now,
      items: [{ identityKey: DOCUMENT_KEY, slice: SLICE, payload }],
    });
    expect(result.outcome).toBe("refreshed");
    if (result.outcome === "refreshed") {
      expect(result.refreshedIdentityKeys.has(DOCUMENT_KEY)).toBe(
        correction <= 2,
      );
    }
    const row = await readRow(sourceId, DOCUMENT_KEY);
    expect(row?.revivalCount).toBe(Math.min(correction, 2));
    expect(row?.attempts).toBe(1 + Math.min(correction - 1, 2));
    if (correction <= 2) {
      const retired = await retireReconciliationItem(scopedDb, {
        ...options,
        payload,
      });
      expect(retired).toEqual({ outcome: "recorded" });
    } else {
      expect(row?.status).toBe(RECONCILIATION_ITEM_STATUS.TERMINAL);
    }
  }
});

test("held-item batch resolution removes only the revisions it consumed", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-10-02T12:00:00Z");
  for (const identityKey of [DOCUMENT_KEY, DOCKET_KEY]) {
    await parkReconciliationItem(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey,
      slice: SLICE,
      payload: PAYLOAD,
      revisionOf: (payload) => payload,
      now,
      errorTag: "unavailable",
    });
  }
  const due = await selectDueReconciliationItems(scopedDb, {
    sourceId,
    now: new Date("2026-10-03T12:00:00Z"),
    limit: 10,
  });
  expect(
    await resolveReconciliationItems(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      items: due.map(({ identityKey, payloadHash }) => ({
        identityKey,
        payloadHash:
          identityKey === DOCKET_KEY
            ? fingerprintReconciliationPayload({ newer: true })
            : payloadHash,
      })),
    }),
  ).toEqual({ outcome: "superseded" });
  expect(await readRow(sourceId, DOCUMENT_KEY)).toBeUndefined();
  expect((await readRow(sourceId, DOCKET_KEY))?.payload).toEqual(PAYLOAD);
});

test("held-item batch resolution uses stored revisions despite lossy JSON numbers", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-10-02T12:00:00Z");
  for (const payloadHash of [
    null,
    fingerprintReconciliationPayload({ revision: "r1" }),
  ]) {
    await parkReconciliationItem(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      identityKey: DOCUMENT_KEY,
      slice: SLICE,
      payload: { revision: "r1" },
      revisionOf: (payload) => payload,
      now,
      errorTag: "unavailable",
    });
    await db
      .update(caseLawReconciliationItems)
      .set({
        payload: sql`'{"revision":"r1","counter":9007199254740993}'::jsonb`,
        payloadHash,
      })
      .where(eq(caseLawReconciliationItems.sourceId, sourceId));
    const due = await selectDueReconciliationItems(scopedDb, {
      sourceId,
      now: new Date("2026-10-03T12:00:00Z"),
      limit: 10,
    });
    expect(due).toHaveLength(1);
    expect(due.at(0)?.payload).toEqual({
      revision: "r1",
      counter: 9_007_199_254_740_992,
    });
    expect(JSON.stringify(due.at(0)?.payload)).not.toContain(
      "9007199254740993",
    );
    expect(
      await resolveReconciliationItems(scopedDb, {
        sourceId,
        leaseToken: LEASE_TOKEN,
        items: due,
      }),
    ).toEqual({ outcome: "recorded" });
    expect(await readRow(sourceId, DOCUMENT_KEY)).toBeUndefined();
  }
});
