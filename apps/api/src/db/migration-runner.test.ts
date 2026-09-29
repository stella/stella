import { expect, test } from "bun:test";

import { validateLedger } from "../lib/db/migration-ledger";
import { decideLedgerAheadPolicy } from "./migration-runner";

const A = "20260929100000_first";
const B = "20260929110000_second";
const NEWER = "20260930100000_newer";
const NEWEST = "20260930110000_newest";

const bundle = [
  { name: A, hash: "first", folderMillis: 1, sql: ["SELECT 1;"] },
  { name: B, hash: "second", folderMillis: 2, sql: ["SELECT 2;"] },
];

const receipt = (id: number, name: string, hash: string) => ({
  id,
  name,
  hash,
  created_at: id,
});

test("ledger-ahead policy refuses pending SQL and no-ops otherwise", () => {
  const applied = receipt(1, A, "first");
  const newer = receipt(2, NEWER, "newer");
  const pending = validateLedger({
    receipts: [applied, newer],
    bundle,
    inventory: [],
  });
  expect(decideLedgerAheadPolicy(pending)).toEqual({
    status: "stale_bundle_refused",
    unknownCount: 1,
    newestUnknownName: NEWER,
    unknownNames: [NEWER],
    mismatchCount: 0,
    mismatchedNames: [],
  });

  const complete = validateLedger({
    receipts: [
      applied,
      receipt(3, B, "second"),
      newer,
      receipt(4, NEWEST, "newest"),
    ],
    bundle,
    inventory: [],
  });
  expect(decideLedgerAheadPolicy(complete)).toEqual({
    status: "stale_bundle_noop",
    unknownCount: 2,
    newestUnknownName: NEWEST,
    unknownNames: [NEWER, NEWEST],
    mismatchCount: 0,
    mismatchedNames: [],
  });
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: [applied, receipt(3, B, "second")],
        bundle,
        inventory: [],
      }),
    ),
  ).toEqual({ status: "ready" });
});

test("an alias rewrite ahead of this bundle joins an unknown migration in the rollback decision", () => {
  const newerLedger = [receipt(1, A, "h2"), receipt(2, NEWER, "newer")];
  const olderA = { name: A, hash: "h1", folderMillis: 1, sql: ["SELECT 1;"] };
  const olderBundle = [olderA];
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: newerLedger,
        bundle: olderBundle,
        inventory: [],
      }),
    ),
  ).toEqual({
    status: "stale_bundle_noop",
    unknownCount: 1,
    newestUnknownName: NEWER,
    unknownNames: [NEWER],
    mismatchCount: 1,
    mismatchedNames: [A],
  });
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: newerLedger,
        bundle: [
          olderA,
          { name: B, hash: "second", folderMillis: 2, sql: ["SELECT 2;"] },
        ],
        inventory: [],
      }),
    ),
  ).toMatchObject({
    status: "stale_bundle_refused",
    unknownCount: 1,
    mismatchCount: 1,
  });
});
