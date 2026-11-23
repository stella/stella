import { describe, expect, test } from "bun:test";

import type { DictationLearnedFixChange } from "@stll/api-contract/dictation-learned-fixes";

import {
  applyDeviceChanges,
  REMEMBERED_CHANGE_IDS,
} from "@/api/lib/dictation/learned-fixes";

const changeId = (index: number) =>
  `0b8f8f3e-2b1c-4f7a-9a6e-${index.toString(16).padStart(12, "0")}`;

const corrected = (index: number): DictationLearnedFixChange => ({
  id: changeId(index),
  type: "corrected",
  from: "dvorakovi",
  to: "Dvořákovi",
});

describe("applying a device's changes", () => {
  test("a change already remembered is skipped", () => {
    const current = {
      generation: 2,
      stored: { fixes: [], changeIds: [changeId(1)] },
    };
    expect(
      applyDeviceChanges(current, { generation: 2, changes: [corrected(1)] }),
    ).toBeNull();
  });

  test("changes from another generation are skipped", () => {
    const current = { generation: 3, stored: { fixes: [], changeIds: [] } };
    expect(
      applyDeviceChanges(current, { generation: 2, changes: [corrected(1)] }),
    ).toBeNull();
  });

  test("a full record starts the next generation, so a change from before it is never applied twice", () => {
    const remembered = Array.from(
      { length: REMEMBERED_CHANGE_IDS },
      (_, index) => changeId(index),
    );
    const full = applyDeviceChanges(
      { generation: 4, stored: { fixes: [], changeIds: remembered } },
      { generation: 4, changes: [corrected(REMEMBERED_CHANGE_IDS)] },
    );
    expect(full?.generation).toBe(5);
    expect(full?.next.changeIds).toEqual([]);
    expect(full?.next.fixes).toHaveLength(1);
    if (full === null) {
      return;
    }
    // The oldest change, retried from the generation it was made in.
    expect(
      applyDeviceChanges(
        { generation: full.generation, stored: full.next },
        { generation: 4, changes: [corrected(0)] },
      ),
    ).toBeNull();
  });

  test("below the limit the record keeps every applied id", () => {
    const next = applyDeviceChanges(
      { generation: 0, stored: { fixes: [], changeIds: [changeId(1)] } },
      { generation: 0, changes: [corrected(2), corrected(2)] },
    );
    expect(next?.generation).toBe(0);
    expect(next?.next.changeIds).toEqual([changeId(1), changeId(2)]);
  });
});
