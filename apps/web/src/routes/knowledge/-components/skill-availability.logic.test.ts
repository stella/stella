import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import {
  coerceSkillAvailability,
  skillAvailabilityOptions,
  skillBindingBody,
} from "@/routes/knowledge/-components/skill-availability.logic";

const MATTER_ID = toSafeId<"workspace">("00000000-0000-7000-8000-0000000000a1");
const CLIENT_ID = toSafeId<"contact">("00000000-0000-7000-8000-0000000000c1");

describe("skillAvailabilityOptions", () => {
  test("only admins and owners may bind a skill to a client", () => {
    expect(
      skillAvailabilityOptions({ canManageTeam: true, scope: "private" }),
    ).toEqual(["everywhere", "matter", "client"]);
    expect(
      skillAvailabilityOptions({ canManageTeam: false, scope: "private" }),
    ).toEqual(["everywhere", "matter"]);
  });

  test("a member shares a skill with the team only through a matter", () => {
    expect(
      skillAvailabilityOptions({ canManageTeam: false, scope: "team" }),
    ).toEqual(["matter"]);
    expect(
      skillAvailabilityOptions({ canManageTeam: true, scope: "team" }),
    ).toEqual(["everywhere", "matter", "client"]);
  });
});

describe("coerceSkillAvailability", () => {
  test("a member switching to team scope lands on one matter", () => {
    expect(
      coerceSkillAvailability({
        availability: "everywhere",
        canManageTeam: false,
        scope: "team",
      }),
    ).toBe("matter");
  });

  test("a choice the new scope still allows is kept", () => {
    expect(
      coerceSkillAvailability({
        availability: "client",
        canManageTeam: true,
        scope: "team",
      }),
    ).toBe("client");
    expect(
      coerceSkillAvailability({
        availability: "matter",
        canManageTeam: false,
        scope: "private",
      }),
    ).toBe("matter");
  });
});

describe("skillBindingBody", () => {
  test("an unbound skill sends no binding", () => {
    expect(
      skillBindingBody({
        availability: "everywhere",
        clientId: CLIENT_ID,
        matterId: MATTER_ID,
      }),
    ).toEqual({});
  });

  test("a matter binding sends only the matter", () => {
    expect(
      skillBindingBody({
        availability: "matter",
        clientId: CLIENT_ID,
        matterId: MATTER_ID,
      }),
    ).toEqual({ boundWorkspaceId: MATTER_ID });
  });

  test("a client binding sends only the client", () => {
    expect(
      skillBindingBody({
        availability: "client",
        clientId: CLIENT_ID,
        matterId: MATTER_ID,
      }),
    ).toEqual({ boundClientId: CLIENT_ID });
  });

  test("a binding without its matter or client cannot be sent yet", () => {
    expect(
      skillBindingBody({
        availability: "matter",
        clientId: null,
        matterId: null,
      }),
    ).toBeNull();
    expect(
      skillBindingBody({
        availability: "client",
        clientId: null,
        matterId: null,
      }),
    ).toBeNull();
  });
});
