import { describe, expect, test } from "bun:test";

import {
  acceptDecisions,
  collectAmbiguities,
  resolveAmbiguitiesByRule,
  roleItemId,
  scopeItemId,
  targetItemId,
} from "@/api/lib/templates/house-style/ambiguity";
import type { AmbiguityItem } from "@/api/lib/templates/house-style/ambiguity";
import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";
import type { RoleProposal } from "@/api/lib/templates/house-style/role-proposer";

const reference = (
  id: string,
  scope: DetectedReference["scope"],
  candidates: number[],
): DetectedReference => ({
  id,
  blockId: "p9",
  start: 0,
  end: 4,
  scope,
  confidence: 0.5,
  evidence: [],
  designators: [
    {
      start: 0,
      end: 4,
      level: "clause",
      join: null,
      resolution:
        candidates.length === 0
          ? { status: "resolved", targetBlockId: "p1", confidence: 0.9 }
          : {
              status: "ambiguous",
              candidates: candidates.map((confidence, position) => ({
                targetBlockId: `p${String(position + 1)}`,
                confidence,
              })),
            },
    },
  ],
});

const role = (blockId: string, confidence: number): RoleProposal => ({
  blockId,
  role: "continuation",
  confidence,
  alternatives: [{ role: "body", confidence: 0.2 }],
  mergedIntoBlockId: null,
});

const ITEMS = collectAmbiguities({
  references: [
    reference("p9:0", "unknown", []),
    reference("p9:10", "internal", [0.9, 0.4]),
    reference("p9:20", "internal", [0.6, 0.5]),
  ],
  roles: [role("p3", 0.35), role("p4", 0.7)],
});

describe("collectAmbiguities", () => {
  test("asks about undecided scopes, several candidate targets and doubtful roles", () => {
    expect(
      ITEMS.map(({ id, kind }) => [id, kind] satisfies [string, string]),
    ).toEqual([
      [scopeItemId("p9:0"), "referenceScope"],
      [targetItemId("p9:10", 0), "referenceTarget"],
      [targetItemId("p9:20", 0), "referenceTarget"],
      [roleItemId("p3"), "blockRole"],
    ]);
  });

  test("an item carries ids and options, never text", () => {
    const isIdLike = (value: unknown): boolean =>
      typeof value === "number" ||
      (typeof value === "string" && /^[\w:]+$/u.test(value));
    const leaves = (value: unknown): unknown[] =>
      typeof value === "object" && value !== null
        ? Object.values(value).flatMap(leaves)
        : [value];
    expect(ITEMS.flatMap(leaves).every(isIdLike)).toBe(true);
  });
});

describe("acceptDecisions", () => {
  test("keeps an answer that picks an offered option and drops every other", () => {
    const accepted = acceptDecisions(ITEMS, [
      { id: scopeItemId("p9:0"), choice: "internal" },
      // A block the detector did not offer.
      { id: targetItemId("p9:10", 0), choice: "p77" },
      { id: targetItemId("p9:20", 0), choice: "p2" },
      // A second answer to the same item.
      { id: targetItemId("p9:20", 0), choice: "p1" },
      { id: roleItemId("p3"), choice: "Smlouva o dílo" },
      { id: "role:p404", choice: "body" },
      { id: roleItemId("p3"), choice: null },
    ]);
    expect([...accepted]).toEqual([
      [scopeItemId("p9:0"), "internal"],
      [targetItemId("p9:20", 0), "p2"],
    ]);
  });
});

describe("resolveAmbiguitiesByRule", () => {
  test("takes a target only when it clearly leads and leaves scopes and roles open", async () => {
    const decisions = await resolveAmbiguitiesByRule(ITEMS);
    expect(decisions).toEqual([
      { id: scopeItemId("p9:0"), choice: null },
      { id: targetItemId("p9:10", 0), choice: "p1" },
      { id: targetItemId("p9:20", 0), choice: null },
      { id: roleItemId("p3"), choice: null },
    ]);
    const items: readonly AmbiguityItem[] = ITEMS;
    expect([...acceptDecisions(items, decisions).keys()]).toEqual([
      targetItemId("p9:10", 0),
    ]);
  });
});
