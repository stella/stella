import { expect, spyOn, test } from "bun:test";

import { getAnalytics } from "@/lib/analytics/provider";

import { createSerializedSaver } from "./serialized-save";

test("serialized saves coalesce per key while keeping the batch's first snapshot", async () => {
  const release = Promise.withResolvers<undefined>();
  const followupStarted = Promise.withResolvers<undefined>();
  const writes: { key: string; markdown: string; snapshot: string }[] = [];
  const pending: boolean[] = [];
  const save = createSerializedSaver(
    async (
      key,
      value: { markdown: string; snapshot: string },
      { initialValue, hasPending },
    ) => {
      writes.push({
        key,
        markdown: value.markdown,
        snapshot: initialValue.snapshot,
      });
      if (value.markdown === "first") {
        await release.promise;
        pending.push(hasPending());
      }
      if (
        key === "one" &&
        writes.filter((write) => write.key === key).length === 2
      ) {
        pending.push(hasPending());
        followupStarted.resolve(undefined);
      }
    },
  );
  save("one", { markdown: "first", snapshot: "original tab" });
  save("one", { markdown: "discarded", snapshot: "changed tab" });
  save("one", { markdown: "latest", snapshot: "newest tab" });
  save("two", { markdown: "independent", snapshot: "other tab" });
  expect(writes).toEqual([
    { key: "one", markdown: "first", snapshot: "original tab" },
    { key: "two", markdown: "independent", snapshot: "other tab" },
  ]);
  release.resolve(undefined);
  await followupStarted.promise;
  expect(writes).toEqual([
    { key: "one", markdown: "first", snapshot: "original tab" },
    { key: "two", markdown: "independent", snapshot: "other tab" },
    { key: "one", markdown: "latest", snapshot: "original tab" },
  ]);
  expect(pending).toEqual([true, false]);
});

test("an idle serialized queue starts a new snapshot batch", async () => {
  const snapshots: string[] = [];
  const save = createSerializedSaver(
    async (_key, value: string, { initialValue }) => {
      snapshots.push(`${initialValue}:${value}`);
    },
  );
  save("tab", "old");
  // The owner settles an already-completed write in the next microtask.
  await Promise.resolve(undefined);
  save("tab", "new");
  await Promise.resolve(undefined);
  expect(snapshots).toEqual(["old:old", "new:new"]);
});

test("a rejected save reports its failure and drains the latest queued value", async () => {
  const release = Promise.withResolvers<undefined>();
  const reported = Promise.withResolvers<undefined>();
  const failure = new TypeError("Transport failed");
  const errors: unknown[] = [];
  const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
    (error) => {
      errors.push(error);
      reported.resolve(undefined);
    },
  );
  const writes: string[] = [];
  const save = createSerializedSaver(
    async (_key, value: string, { initialValue }) => {
      writes.push(`${initialValue}:${value}`);
      if (value === "first") {
        await release.promise;
      }
    },
  );
  try {
    save("tab", "first");
    save("tab", "discarded");
    save("tab", "latest");
    release.reject(failure);
    await reported.promise;
    expect(errors).toEqual([failure]);
    expect(writes).toEqual(["first:first", "first:latest"]);
    save("tab", "later");
    expect(writes).toEqual(["first:first", "first:latest", "later:later"]);
  } finally {
    capture.mockRestore();
  }
});
