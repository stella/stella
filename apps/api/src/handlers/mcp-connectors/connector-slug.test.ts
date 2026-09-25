import { describe, expect, test } from "bun:test";

import {
  connectorSlugCandidates,
  firstFreeConnectorSlug,
} from "@/api/handlers/mcp-connectors/connector-slug";

describe("connector slug selection", () => {
  test("tries the base first, then numbered suffixes from two to fifty", () => {
    const candidates = connectorSlugCandidates("registry");

    expect(candidates).toHaveLength(50);
    expect(candidates.slice(0, 3)).toEqual([
      "registry",
      "registry-2",
      "registry-3",
    ]);
    expect(candidates.at(-1)).toBe("registry-50");
  });

  test("keeps the base when nothing holds it", () => {
    const candidates = connectorSlugCandidates("registry");

    expect(
      firstFreeConnectorSlug({
        base: "registry",
        candidates,
        taken: new Set(["registry-2"]),
      }),
    ).toBe("registry");
  });

  test("takes the lowest free suffix, not the one after the highest taken", () => {
    const candidates = connectorSlugCandidates("registry");

    expect(
      firstFreeConnectorSlug({
        base: "registry",
        candidates,
        taken: new Set(["registry", "registry-2", "registry-4"]),
      }),
    ).toBe("registry-3");
  });

  test("falls back to a random suffix once every candidate is taken", () => {
    const candidates = connectorSlugCandidates("registry");
    const pick = () =>
      firstFreeConnectorSlug({
        base: "registry",
        candidates,
        taken: new Set(candidates),
      });

    // Two picks in the same millisecond share a UUIDv7 timestamp, so they
    // differ only if the suffix comes from the random bits.
    const first = pick();
    const second = pick();

    expect(candidates).not.toContain(first);
    expect(first).toMatch(/^registry-[0-9a-f]{12}$/u);
    expect(second).not.toBe(first);
  });
});
