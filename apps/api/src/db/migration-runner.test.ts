import { expect, test } from "bun:test";

import { validateLedger } from "../lib/db/migration-ledger";
import { decideStaleBundleOptionA } from "./migration-runner";

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

test("option A refuses stale bundles with pending SQL and no-ops otherwise", () => {
  const applied = receipt(1, A, "first");
  const newer = receipt(2, NEWER, "newer");
  const pending = validateLedger({
    receipts: [applied, newer],
    bundle,
    inventory: [],
  });
  expect(decideStaleBundleOptionA(pending)).toEqual({
    status: "stale_bundle_refused",
    unknownCount: 1,
    newestUnknownName: NEWER,
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
  expect(decideStaleBundleOptionA(complete)).toEqual({
    status: "stale_bundle_noop",
    unknownCount: 2,
    newestUnknownName: NEWEST,
  });
  expect(
    decideStaleBundleOptionA(
      validateLedger({
        receipts: [applied, receipt(3, B, "second")],
        bundle,
        inventory: [],
      }),
    ),
  ).toEqual({ status: "ready" });
});
