import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createCitationSurfaceInventory } from "@stll/scripts/src/citation-surface-inventory";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CITATION_INVENTORY = createCitationSurfaceInventory(SOURCE_ROOT);

describe("chat citation surface ownership", () => {
  test("all discovered markdown overrides and source sinks use the shared legal resolver", () => {
    const result = CITATION_INVENTORY.inspect();
    expect(result.hostCount).toBeGreaterThan(0);
    expect(result.anchorCount).toBeGreaterThan(0);
    expect(result.sinkCount).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
  test("a plain anchor override cannot silently bypass citation navigation", () => {
    const anchor = CITATION_INVENTORY.inspect().sharedAnchorOverrides.at(0);
    expect(anchor).toBeDefined();
    if (anchor === undefined) {
      return;
    }
    const mutated = `${anchor.sourceText.slice(0, anchor.start)}(props) => <a {...props} />${anchor.sourceText.slice(anchor.end)}`;
    const result = CITATION_INVENTORY.inspect(
      new Map([[anchor.filePath, mutated]]),
    );
    expect(
      result.failures.some((failure) =>
        failure.startsWith("Bypassing markdown anchor"),
      ),
    ).toBe(true);
  });
});
