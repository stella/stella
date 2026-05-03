import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";

import {
  intersectAccessibleWorkspaceIds,
  resolveToolWorkspaceIds,
} from "./authorized-workspace-ids";

const wsA = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
const wsB = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");
const wsC = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000c");
const wsStale = toSafeId<"workspace">("00000000-0000-0000-0000-0000000000ff");

const asArray = (ids: readonly SafeId<"workspace">[]): SafeId<"workspace">[] =>
  Array.from(ids);

describe("resolveToolWorkspaceIds", () => {
  test("no pins → returns the full accessible set", () => {
    expect(
      asArray(
        resolveToolWorkspaceIds({
          pinnedIds: [],
          accessibleWorkspaceIds: [wsA, wsB],
        }),
      ),
    ).toEqual([wsA, wsB]);
  });

  test("all pins still accessible → returns the pins", () => {
    expect(
      asArray(
        resolveToolWorkspaceIds({
          pinnedIds: [wsA, wsB],
          accessibleWorkspaceIds: [wsA, wsB, wsC],
        }),
      ),
    ).toEqual([wsA, wsB]);
  });

  test("partially stale pins → returns only the still-accessible ones", () => {
    expect(
      asArray(
        resolveToolWorkspaceIds({
          pinnedIds: [wsA, wsStale, wsB],
          accessibleWorkspaceIds: [wsA, wsB, wsC],
        }),
      ),
    ).toEqual([wsA, wsB]);
  });

  test("regression: pins entirely stale → falls back to accessible, never to the stale set", () => {
    const result = asArray(
      resolveToolWorkspaceIds({
        pinnedIds: [wsStale],
        accessibleWorkspaceIds: [wsA, wsB],
      }),
    );
    expect(result).toEqual([wsA, wsB]);
    expect(result).not.toContain(wsStale);
  });

  test("regression: stale pin must never reach tool surface even when other pins are valid", () => {
    const result = asArray(
      resolveToolWorkspaceIds({
        pinnedIds: [wsA, wsStale],
        accessibleWorkspaceIds: [wsA],
      }),
    );
    expect(result).not.toContain(wsStale);
  });

  test("empty accessible + empty pins → empty result", () => {
    expect(
      asArray(
        resolveToolWorkspaceIds({
          pinnedIds: [],
          accessibleWorkspaceIds: [],
        }),
      ),
    ).toEqual([]);
  });

  test("empty accessible + non-empty pins → empty result (no fallback to pins)", () => {
    expect(
      asArray(
        resolveToolWorkspaceIds({
          pinnedIds: [wsA, wsB],
          accessibleWorkspaceIds: [],
        }),
      ),
    ).toEqual([]);
  });
});

describe("intersectAccessibleWorkspaceIds", () => {
  test("strips stale IDs without falling back to accessible", () => {
    expect(
      intersectAccessibleWorkspaceIds({
        pinnedIds: [wsA, wsStale, wsB],
        accessibleWorkspaceIds: [wsA, wsB, wsC],
      }),
    ).toEqual([wsA, wsB]);
  });

  test("regression: all pins stale → returns empty (does NOT widen back to accessible)", () => {
    expect(
      intersectAccessibleWorkspaceIds({
        pinnedIds: [wsStale],
        accessibleWorkspaceIds: [wsA, wsB],
      }),
    ).toEqual([]);
  });

  test("empty pins → empty result", () => {
    expect(
      intersectAccessibleWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [wsA, wsB],
      }),
    ).toEqual([]);
  });
});
