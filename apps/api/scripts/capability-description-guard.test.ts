import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-data";
import { findUndescribedIds } from "./capability-description-guard";
import { isRecord } from "./lib/enumerate-safe-handlers";

const readEntries = (
  catalog: unknown,
): { id: string; description?: string }[] =>
  (Array.isArray(catalog) ? catalog : []).map((entry: unknown) => {
    if (!isRecord(entry)) {
      throw new TypeError("capability catalog entry is not an object");
    }
    const id = entry["id"];
    const description = entry["description"];
    if (typeof id !== "string") {
      throw new TypeError("capability catalog entry has no string id");
    }
    return typeof description === "string" ? { id, description } : { id };
  });

const entries = readEntries(readCapabilityCatalog());

describe("committed catalog", () => {
  // The same invariant the CI guard enforces, pinned against the real
  // committed artifact rather than a fixture.
  test("carries a description for every capability", () => {
    expect(findUndescribedIds(entries)).toEqual([]);
  });
});

describe("findUndescribedIds", () => {
  test("treats absent, empty, and whitespace-only prose alike", () => {
    expect(
      findUndescribedIds([
        { id: "kept", description: "Does a thing." },
        { id: "absent" },
        { id: "empty", description: "" },
        { id: "blank", description: "\n\t " },
      ]),
    ).toEqual(["absent", "blank", "empty"]);
  });
});
