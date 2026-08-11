import { describe, expect, test } from "bun:test";

import {
  CONTACT_IMPORT_SCHEMA_VERSION,
  type ContactImportMapping,
} from "@stll/api-contract";

import {
  clearContactImportRequest,
  resolveContactImportRequest,
} from "@/routes/_protected.contacts/-contact-import-request";

const MAPPING = {
  version: CONTACT_IMPORT_SCHEMA_VERSION,
  defaultType: "person",
  generateDisplayName: false,
  columns: [{ sourceIndex: 0, targetField: "display_name" }],
} as const satisfies ContactImportMapping;

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("contact import request identity", () => {
  test("reuses a pending key for the same file and mapping across reloads", async () => {
    const storage = createStorage();
    const file = new Blob(["Name\nJane Doe"]);

    const first = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      storage,
    });
    const afterReload = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      storage,
    });

    expect(afterReload).toEqual(first);
  });

  test("clears a completed request so a deliberate later import is new", async () => {
    const storage = createStorage();
    const file = new Blob(["Name\nJane Doe"]);
    const first = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      storage,
    });

    clearContactImportRequest({ storageKey: first.storageKey, storage });
    const later = await resolveContactImportRequest({
      file,
      mapping: MAPPING,
      storage,
    });

    expect(later.id).not.toBe(first.id);
  });
});
