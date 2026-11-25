import { describe, expect, test } from "bun:test";

import { parseDocxBlockManifest } from "@/api/lib/templates/house-style/folio-contract";
import {
  czechContract,
  manifestOf,
} from "@/api/lib/templates/house-style/manifest.test-helpers";

describe("parseDocxBlockManifest", () => {
  test("accepts a manifest as the engine reports it", () => {
    const manifest = czechContract("Text.");
    expect(parseDocxBlockManifest(manifest).unwrap()).toEqual(manifest);
  });

  test("accepts a table with its cells", () => {
    const [block] = manifestOf(["buňka"]).blocks;
    const table = {
      ...block,
      id: "t0",
      kind: "table",
      cells: [{ row: 0, col: 0, blockIds: ["p0"] }],
    };
    const parsed = parseDocxBlockManifest({
      ...manifestOf([]),
      blocks: [table, block],
    });
    expect(parsed.isOk()).toBe(true);
  });

  test("names the place of a mismatch without quoting the document", () => {
    const manifest = manifestOf(["Důvěrný text smlouvy."]);
    const parsed = parseDocxBlockManifest({
      ...manifest,
      blocks: manifest.blocks.map((block) => ({ ...block, label: 7 })),
    });
    expect(parsed.isErr() && parsed.error.message).toBe(
      "Block manifest does not match the contract at blocks.0.label",
    );
  });

  test("refuses unknown keys and repeated block ids", () => {
    const manifest = manifestOf(["První.", "Druhý."]);
    expect(parseDocxBlockManifest({ ...manifest, extra: true }).isErr()).toBe(
      true,
    );
    const repeated = parseDocxBlockManifest({
      ...manifest,
      blocks: manifest.blocks.map((block) => ({ ...block, id: "p0" })),
    });
    expect(repeated.isErr() && repeated.error.message).toBe(
      "Block manifest repeats a block id",
    );
  });
});
