import { describe, expect, test } from "bun:test";

import { planSharepointImport } from "@/api/handlers/sharepoint/import-file";
import { toSafeId } from "@/api/lib/branded-types";

const entityId = toSafeId<"entity">("019e7000-0000-7000-8000-000000000001");

describe("planning a SharePoint import", () => {
  test("an item the matter has never imported becomes a new document", () => {
    expect(
      planSharepointImport({ imported: null, contentHash: "a".repeat(64) }),
    ).toEqual({
      type: "create",
    });
  });

  test("re-importing at the same content is a no-op on the same document", () => {
    expect(
      planSharepointImport({
        imported: { entityId, contentHash: "a".repeat(64) },
        contentHash: "a".repeat(64),
      }),
    ).toEqual({ type: "unchanged", entityId });
  });

  test("changed content adds a version to the document imported before", () => {
    expect(
      planSharepointImport({
        imported: { entityId, contentHash: "a".repeat(64) },
        contentHash: "b".repeat(64),
      }),
    ).toEqual({ type: "version", entityId });
  });

  test("applying the plan's outcome makes the next plan a no-op", () => {
    for (const imported of [null, { entityId, contentHash: "a".repeat(64) }]) {
      const contentHash = "c".repeat(64);
      const plan = planSharepointImport({ imported, contentHash });
      const after = {
        entityId: plan.type === "create" ? entityId : plan.entityId,
        contentHash,
      };
      expect(planSharepointImport({ imported: after, contentHash }).type).toBe(
        "unchanged",
      );
    }
  });
});
