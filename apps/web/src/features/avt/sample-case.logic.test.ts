import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { loadSampleCaseAndOpen } from "@/features/avt/sample-case.logic";
import type { SampleCaseLoad } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const sample = {
  listId: toSafeId<"legalList">("00000000-0000-4000-8000-000000000001"),
  documentEntityId: toSafeId<"entity">("00000000-0000-4000-8000-000000000002"),
  fileFieldId: toSafeId<"field">("00000000-0000-4000-8000-000000000003"),
} satisfies SampleCaseLoad;

describe("opening the server-loaded sample", () => {
  test("loads once and opens only the committed list", async () => {
    const events: string[] = [];
    const result = await loadSampleCaseAndOpen({
      load: async () => {
        events.push("load");
        return sample;
      },
      openList: async (listId) => {
        events.push(listId);
      },
    });
    expect(result).toEqual(sample);
    expect(events).toEqual(["load", sample.listId]);
  });

  test("a refused load leaves the view alone and propagates its error", async () => {
    const opened: string[] = [];
    expect(
      await rejectionOf(
        loadSampleCaseAndOpen({
          load: async () => {
            throw new TypeError("Sample access refused");
          },
          openList: async (listId) => {
            opened.push(listId);
          },
        }),
      ),
    ).toMatchObject({ message: "Sample access refused" });
    expect(opened).toEqual([]);
  });

  test("a failed view switch is surfaced and a repeat opens the same sample", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      return sample;
    };
    expect(
      await rejectionOf(
        loadSampleCaseAndOpen({
          load,
          openList: async () => {
            throw new TypeError("View save failed");
          },
        }),
      ),
    ).toMatchObject({ message: "View save failed" });
    const opened: string[] = [];
    expect(
      await loadSampleCaseAndOpen({
        load,
        openList: async (listId) => {
          opened.push(listId);
        },
      }),
    ).toEqual(sample);
    expect(calls).toBe(2);
    expect(opened).toEqual([sample.listId]);
  });
});
