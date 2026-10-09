import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rootDb } from "@/api/db/root";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import type {
  OrganizationAccess,
  OrganizationAccessType,
} from "@/api/lib/usage/organization-access";
import {
  allowsLawRead,
  mayReadPublicLaw,
} from "@/api/lib/usage/organization-access-state";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const parsedOrganizationId = parseAuthProviderId<"organization">(
  "00000000-0000-7000-8000-000000000001",
);
const ORGANIZATION_ID =
  parsedOrganizationId ?? panic("Test organization id is invalid");

const ACCESS_BY_TYPE = {
  paid: { type: "paid", deadline: NOW, serviceActionsPerPeriod: 1 },
  evaluation: { type: "evaluation", endsAt: NOW },
  free: { type: "free", serviceActionsPerPeriod: 1 },
  self_managed_keys: { type: "self_managed_keys" },
  ended: { type: "ended" },
  unavailable: { type: "unavailable" },
} as const satisfies Record<OrganizationAccessType, OrganizationAccess>;

const EXPECTED_BY_TYPE = {
  paid: true,
  evaluation: true,
  free: true,
  self_managed_keys: false,
  ended: false,
  unavailable: false,
} as const satisfies Record<OrganizationAccessType, boolean>;

describe("public-law organization access", () => {
  test("does not read access and grants access while enforcement is off", async () => {
    let readCount = 0;
    const allowed = await mayReadPublicLaw(rootDb, ORGANIZATION_ID, {
      organizationAccessEnabled: () => false,
      readAccess: async () => {
        readCount += 1;
        return ACCESS_BY_TYPE.unavailable;
      },
    });

    expect(allowed).toEqual(Result.ok(true));
    expect(readCount).toBe(0);
  });

  test("maps every organization access standing while enforcement is on", async () => {
    for (const access of Object.values(ACCESS_BY_TYPE)) {
      const allowed = await mayReadPublicLaw(rootDb, ORGANIZATION_ID, {
        organizationAccessEnabled: () => true,
        readAccess: async () => access,
      });

      expect(allowsLawRead(access)).toBe(EXPECTED_BY_TYPE[access.type]);
      expect(allowed).toEqual(Result.ok(EXPECTED_BY_TYPE[access.type]));
    }
  });
});
