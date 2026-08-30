import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ensureOutlookSourceId } from "@/lib/outlook-source-id";

const sourceId = "00000000-0000-7000-8000-000000000001";

describe("ensureOutlookSourceId", () => {
  test("reuses a persisted source id across task-pane remounts", async () => {
    let propertyWrites = 0;
    let itemWrites = 0;

    const result = await ensureOutlookSourceId({
      existing: sourceId,
      mode: "read",
      persistItem: async () => {
        itemWrites += 1;
      },
      persistProperty: async () => {
        propertyWrites += 1;
      },
    });

    expect(result).toBe(sourceId);
    expect(propertyWrites).toBe(0);
    expect(itemWrites).toBe(0);
  });

  test("persists a new compose identity on both property bag and draft", async () => {
    const writes: string[] = [];

    const result = await ensureOutlookSourceId({
      createId: () => sourceId,
      existing: undefined,
      mode: "compose",
      persistItem: async () => {
        writes.push("item");
      },
      persistProperty: async (value) => {
        writes.push(`property:${value}`);
      },
    });

    expect(result).toBe(sourceId);
    expect(writes).toEqual([`property:${sourceId}`, "item"]);
  });

  test("does not issue an identity when custom-property persistence fails", async () => {
    const failure = new Error("offline");

    const result = await Result.tryPromise(
      async () =>
        await ensureOutlookSourceId({
          createId: () => sourceId,
          existing: null,
          mode: "read",
          persistItem: async () => undefined,
          persistProperty: async () => {
            throw failure;
          },
        }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toBe(failure);
    }
  });
});
