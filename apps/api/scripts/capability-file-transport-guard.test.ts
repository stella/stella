import { describe, expect, test } from "bun:test";

import ledger from "../capability-file-transport-ledger.json" with { type: "json" };
import {
  findSuppressedIds,
  readRepositoryCatalog,
} from "./capability-file-transport-guard";

const entries = await readRepositoryCatalog();

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
