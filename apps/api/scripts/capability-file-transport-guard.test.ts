import { describe, expect, test } from "bun:test";

import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import ledger from "../capability-file-transport-ledger.json" with { type: "json" };
import { repositoryCapabilityCatalog } from "../src/tests/helpers/repository-capability-catalog";
import { findSuppressedIds } from "./capability-file-transport-guard";

// The entries the runtime generator derived from the handler graph; the CI
// guard derives the same catalog in memory.
const entries = parseCapabilityCatalog(repositoryCapabilityCatalog) ?? [];

describe("capability file-transport ledger", () => {
  test("measures the catalog derived from handlers, never an absent artifact", () => {
    expect(entries.length).toBeGreaterThan(300);
    const suppressed = findSuppressedIds(entries);
    // A count read from missing files would be 0 and pass any ceiling.
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed).toEqual([...ledger]);
  });

  test("counts byte responses and required file inputs, never optional ones", () => {
    expect(
      findSuppressedIds([
        { id: "a.list", transport: { type: "json" } },
        {
          id: "b.import",
          transport: {
            type: "file-input",
            input: { field: "file", required: false },
          },
        },
        {
          id: "c.upload",
          transport: {
            type: "file-input",
            input: { field: "file", required: true },
          },
        },
        { id: "d.export", transport: { type: "file-response" } },
        {
          id: "e.convert",
          transport: {
            type: "file-both",
            input: { field: "file", required: false },
          },
        },
      ]),
    ).toEqual(["c.upload", "d.export", "e.convert"]);
  });
});
