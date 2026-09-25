import { describe, expect, test } from "bun:test";

import { skillEditAccess } from "./skill-history.logic";

const OWNER_ID = "user-owner";
const OTHER_ID = "user-other";

describe("skill edit access", () => {
  test("a member viewing a team skill may change nothing", () => {
    expect(
      skillEditAccess({
        scope: "team",
        ownerUserId: null,
        origin: "authored",
        memberRole: "member",
        userId: OTHER_ID,
      }),
    ).toBe("none");
  });

  test("an admin may edit an authored team skill", () => {
    expect(
      skillEditAccess({
        scope: "team",
        ownerUserId: null,
        origin: "authored",
        memberRole: "admin",
        userId: OTHER_ID,
      }),
    ).toBe("content");
  });

  test("a team skill stays read-only while the member role is loading", () => {
    expect(
      skillEditAccess({
        scope: "team",
        ownerUserId: null,
        origin: "authored",
        memberRole: undefined,
        userId: OTHER_ID,
      }),
    ).toBe("none");
  });

  test("the author of a private skill may edit it whatever their role", () => {
    expect(
      skillEditAccess({
        scope: "private",
        ownerUserId: OWNER_ID,
        origin: "upload",
        memberRole: "member",
        userId: OWNER_ID,
      }),
    ).toBe("content");
  });

  test("an owner may not edit someone else's private skill", () => {
    expect(
      skillEditAccess({
        scope: "private",
        ownerUserId: OWNER_ID,
        origin: "authored",
        memberRole: "owner",
        userId: OTHER_ID,
      }),
    ).toBe("none");
  });

  test("a manager of a bundled skill may only enable or disable it", () => {
    expect(
      skillEditAccess({
        scope: "team",
        ownerUserId: null,
        origin: "bundled",
        memberRole: "owner",
        userId: OTHER_ID,
      }),
    ).toBe("enablement");
  });
});
