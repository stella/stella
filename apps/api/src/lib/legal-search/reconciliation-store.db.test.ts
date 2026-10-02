import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

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
  RECONCILIATION_RETRY_DELAYS_MS,
  RECONCILIATION_TERMINAL_ATTEMPTS,
  countReconciliationItems,
  countTerminalReconciliationItemsBySlice,
  listReconciliationItems,
  parkReconciliationItem,
  pruneUnlistedTerminalItems,
  refreshTrackedReconciliationItems,
  resetTerminalReconciliationItems,
  resolveReconciliationItem,
  resolveReconciliationItems,
  retireReconciliationItem,
  selectDueReconciliationItems,
} from "@/api/lib/legal-search/reconciliation-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// What is asserted here is the store's own arithmetic against real columns:
// that repeated parks advance one row rather than accumulating rows, that the
// schedule widens and then retires exactly where the constant says, that a
// written decision leaves nothing behind, and that a retry that is not yet due
// is not handed out. Every one of those is invisible in the type system and
// each, wrong, produces a loop that never ends.

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
      errorTag: "publisher-miss",
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
    await pruneUnlistedTerminalItems(scopedDb, {
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

test("the attempt past the schedule retires the item and stops scheduling it", async () => {
  const sourceId = await seedSource();
  const now = new Date("2026-08-11T09:00:00.000Z");

  let attempts = 0;
  while (attempts < RECONCILIATION_TERMINAL_ATTEMPTS) {
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
    expect(parked.outcome).toBe("recorded");
    if (parked.outcome === "recorded") {
      attempts = parked.attempts;
    }
  }

  const row = await readRow(sourceId, DOCUMENT_KEY);
  expect(row?.status).toBe(RECONCILIATION_ITEM_STATUS.TERMINAL);
  expect(row?.attempts).toBe(RECONCILIATION_TERMINAL_ATTEMPTS);
  // A retired item carries no due time, so nothing can hand it out again.
  expect(row?.nextAttemptAt).toBeNull();

  const later = new Date("2027-01-01T00:00:00.000Z");
  expect(
    await selectDueReconciliationItems(scopedDb, {
      sourceId,
      now: later,
      limit: 10,
    }),
  ).toEqual([]);

  // …and it is counted as accounted for, which is what settles its slice.
  expect(
    await countTerminalReconciliationItemsBySlice(scopedDb, {
      sourceId,
      slices: [SLICE],
    }),
  ).toEqual(new Map([[SLICE, 1]]));
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
  expect(row?.attempts).toBe(RECONCILIATION_TERMINAL_ATTEMPTS);
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
    errorTag: "unavailable",
  };
  await retireReconciliationItem(scopedDb, options);
  const before = await readRow(sourceId, DOCUMENT_KEY);
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
  expect(await readRow(sourceId, DOCUMENT_KEY)).toEqual(before);
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
  expect(moved?.attempts).toBe(before?.attempts);
  expect(moved?.status).toBe(before?.status);
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
      errorTag: "unavailable",
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
    errorTag: "unavailable",
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
    expect(row?.attempts).toBe(
      RECONCILIATION_TERMINAL_ATTEMPTS + Math.min(correction - 1, 2),
    );
    if (correction <= 2) {
      const missed = await parkReconciliationItem(scopedDb, {
        ...options,
        payload,
      });
      expect(missed).toMatchObject({
        outcome: "recorded",
        status: RECONCILIATION_ITEM_STATUS.TERMINAL,
      });
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
  expect(
    await resolveReconciliationItems(scopedDb, {
      sourceId,
      leaseToken: LEASE_TOKEN,
      items: [
        { identityKey: DOCUMENT_KEY, payload: PAYLOAD },
        { identityKey: DOCKET_KEY, payload: { newer: true } },
      ],
    }),
  ).toEqual({ outcome: "recorded" });
  expect(await readRow(sourceId, DOCUMENT_KEY)).toBeUndefined();
  expect((await readRow(sourceId, DOCKET_KEY))?.payload).toEqual(PAYLOAD);
});
