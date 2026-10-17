import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-direct-folio-snapshot-retirement";
const lint = async (
  statements: readonly string[],
  sourcePath = "apps/api/src/lib/other.ts",
) => await lintSingleRule(RULE, statements.join("\n"), { sourcePath });

const RETIREMENT_PAYLOAD = [
  "const payload = {",
  "  yjsSnapshotRevision: 0,",
  "  savedSnapshotCut: null,",
  "  yjsSnapshotSizeBytes: null,",
  "  yjsSnapshotUpdatedAt: null,",
  "};",
];

describe.serial("folio snapshot retirement ownership", () => {
  test("rejects every raw retirement field even in extracted update payloads", async () => {
    expect(
      await lint([
        ...RETIREMENT_PAYLOAD,
        "db.update(rooms).set({ ...payload });",
      ]),
    ).toEqual([2, 3, 4, 5]);
  });

  test("resolves immutable value and computed-key aliases", async () => {
    expect(
      await lint([
        "const zero = 0;",
        "const alias = zero;",
        "const cleared = null;",
        'const field = "yjsSnapshotRevision";',
        "const payload = { [field]: alias };",
        'db.update(rooms).set({ ["savedSnapshotCut"]: cleared });',
        "const factory = (zero) => ({ yjsSnapshotRevision: zero });",
      ]),
    ).toEqual([5, 6]);
  });

  test("accepts the retirement owner and test fixtures", async () => {
    expect(
      await lint(
        RETIREMENT_PAYLOAD,
        "apps/api/src/lib/folio-collab-snapshot-retirement.ts",
      ),
    ).toEqual([]);
    expect(
      await lint(RETIREMENT_PAYLOAD, "apps/api/src/lib/other.test.ts"),
    ).toEqual([]);
    expect(
      await lint(
        RETIREMENT_PAYLOAD,
        "apps/api/src/tests/helpers/folio-fixture.ts",
      ),
    ).toEqual([]);
  });

  test("accepts snapshot projections, storage increments and successful-store marker clears", async () => {
    expect(
      await lint([
        "const projection = { yjsSnapshotRevision: rooms.yjsSnapshotRevision };",
        "db.update(rooms).set({ yjsSnapshotRevision: room.yjsSnapshotRevision + 1, yjsSnapshotSizeBytes: snapshotBytes.byteLength, yjsSnapshotUpdatedAt: storedAt, snapshotRecoveredAt: null });",
        "const { yjsSnapshotRevision: revision = 0 } = room;",
      ]),
    ).toEqual([]);
  });
});
