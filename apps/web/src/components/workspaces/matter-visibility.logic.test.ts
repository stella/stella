import { describe, expect, test } from "bun:test";

import {
  defaultMatterVisibilityFor,
  MATTER_VISIBILITIES,
  MATTER_VISIBILITY,
  widensMatterVisibility,
} from "@stll/api-contract/matter-visibility";

import {
  canChangeMatterVisibility,
  FOLLOW_CLIENT_VISIBILITY,
  matterVisibilityChange,
  newMatterVisibility,
} from "./matter-visibility.logic";

const LEAD = "user-lead";
const OTHER = "user-other";

describe("who may change a matter's visibility", () => {
  test.each([
    {
      name: "the lead with update permission",
      canUpdateMatters: true,
      role: "member",
      userId: LEAD,
      expected: true,
    },
    {
      name: "an owner who does not lead the matter",
      canUpdateMatters: true,
      role: "owner",
      userId: OTHER,
      expected: true,
    },
    {
      name: "an admin who does not lead the matter",
      canUpdateMatters: true,
      role: "admin",
      userId: OTHER,
      expected: true,
    },
    {
      name: "a member who does not lead the matter",
      canUpdateMatters: true,
      role: "member",
      userId: OTHER,
      expected: false,
    },
    {
      name: "an intern lead without update permission",
      canUpdateMatters: false,
      role: "intern",
      userId: LEAD,
      expected: false,
    },
    {
      name: "an external lead without update permission",
      canUpdateMatters: false,
      role: "external",
      userId: LEAD,
      expected: false,
    },
    {
      name: "a lead whose role has not loaded",
      canUpdateMatters: false,
      role: undefined,
      userId: LEAD,
      expected: false,
    },
  ])("$name: $expected", ({ canUpdateMatters, role, userId, expected }) => {
    expect(
      canChangeMatterVisibility({
        canUpdateMatters,
        role,
        userId,
        leadUserId: LEAD,
      }),
    ).toBe(expected);
  });
});

describe("classifying a visibility change", () => {
  test("every pair is unchanged, a widening or a narrowing, as the API decides", () => {
    for (const from of MATTER_VISIBILITIES) {
      for (const to of MATTER_VISIBILITIES) {
        const change = matterVisibilityChange({ from, to });
        if (from === to) {
          expect(change).toEqual({ type: "unchanged" });
        } else if (widensMatterVisibility(from, to)) {
          expect(change).toEqual({ type: "widen", visibility: to });
        } else {
          expect(change).toEqual({ type: "narrow", visibility: to });
        }
      }
    }
  });
});

describe("a new matter's visibility", () => {
  test("follows the client until a level is chosen", () => {
    expect(
      newMatterVisibility({
        choice: FOLLOW_CLIENT_VISIBILITY,
        hasClient: false,
      }),
    ).toBe(MATTER_VISIBILITY.assignedOnly);
    expect(
      newMatterVisibility({
        choice: FOLLOW_CLIENT_VISIBILITY,
        hasClient: true,
      }),
    ).toBe(MATTER_VISIBILITY.adminsAndAssigned);
    for (const hasClient of [false, true]) {
      expect(
        newMatterVisibility({ choice: FOLLOW_CLIENT_VISIBILITY, hasClient }),
      ).toBe(defaultMatterVisibilityFor({ hasClient }));
    }
  });

  test("keeps a chosen level whatever the client", () => {
    for (const visibility of MATTER_VISIBILITIES) {
      for (const hasClient of [false, true]) {
        expect(
          newMatterVisibility({
            choice: { type: "chosen", visibility },
            hasClient,
          }),
        ).toBe(visibility);
      }
    }
  });
});
