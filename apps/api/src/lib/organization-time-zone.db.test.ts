import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { parseTimeZoneId } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { organizationSettings, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  readOrganizationTimeZone,
  readWorkspaceOrganizationTimeZone,
} from "@/api/lib/organization-time-zone";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const reader = asTestRaw<Pick<Transaction, "select">>(db);
const zone = (id: string): TimeZoneId =>
  parseTimeZoneId(id) ?? panic(`Runtime does not know ${id}`);

/** One organization per stored state the reader distinguishes. */
const ORGANIZATIONS = {
  chosen: mintAuthProviderId<"organization">(),
  czechDefault: mintAuthProviderId<"organization">(),
  germanDefault: mintAuthProviderId<"organization">(),
  neverSaved: mintAuthProviderId<"organization">(),
};
const chosenWorkspaceId = createSafeId<"workspace">();
const neverSavedWorkspaceId = createSafeId<"workspace">();

beforeAll(async () => {
  await db.insert(organization).values(
    Object.values(ORGANIZATIONS).map((id) => ({
      id,
      name: "Time zone fixture",
      slug: id,
      createdAt: new Date(),
    })),
  );
  await db.insert(organizationSettings).values([
    {
      id: createSafeId<"organizationSettings">(),
      organizationId: ORGANIZATIONS.chosen,
      timeZone: parseTimeZoneId("America/New_York"),
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    },
    {
      id: createSafeId<"organizationSettings">(),
      organizationId: ORGANIZATIONS.czechDefault,
      practiceJurisdictions: [
        { countryCode: "DE", isPrimary: false },
        { countryCode: "CZ", isPrimary: true },
      ],
    },
    {
      id: createSafeId<"organizationSettings">(),
      organizationId: ORGANIZATIONS.germanDefault,
      practiceJurisdictions: [
        { countryCode: "DE", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ],
    },
  ]);
  await db.insert(workspaces).values([
    {
      id: chosenWorkspaceId,
      organizationId: ORGANIZATIONS.chosen,
      name: "Chosen zone matter",
      reference: chosenWorkspaceId,
    },
    {
      id: neverSavedWorkspaceId,
      organizationId: ORGANIZATIONS.neverSaved,
      name: "Default zone matter",
      reference: neverSavedWorkspaceId,
    },
  ]);
});

afterAll(async () => {
  try {
    await db
      .delete(organization)
      .where(inArray(organization.id, Object.values(ORGANIZATIONS)));
  } finally {
    await releaseTestDb();
  }
});

describe("reading an organization's time zone", () => {
  test("a chosen zone wins, else the primary jurisdiction decides", async () => {
    expect({
      chosen: await readOrganizationTimeZone(reader, ORGANIZATIONS.chosen),
      czechDefault: await readOrganizationTimeZone(
        reader,
        ORGANIZATIONS.czechDefault,
      ),
      germanDefault: await readOrganizationTimeZone(
        reader,
        ORGANIZATIONS.germanDefault,
      ),
      neverSaved: await readOrganizationTimeZone(
        reader,
        ORGANIZATIONS.neverSaved,
      ),
    }).toEqual({
      chosen: zone("America/New_York"),
      czechDefault: zone("Europe/Prague"),
      germanDefault: zone("UTC"),
      neverSaved: zone("UTC"),
    });
  });

  test("a workspace reads its organization's zone", async () => {
    expect(
      await readWorkspaceOrganizationTimeZone(reader, chosenWorkspaceId),
    ).toBe(zone("America/New_York"));
    expect(
      await readWorkspaceOrganizationTimeZone(reader, neverSavedWorkspaceId),
    ).toBe(zone("UTC"));
  });

  test("a stored zone the runtime does not know is an invariant break", async () => {
    // Only a write that bypassed parseTimeZoneId can store this.
    await db.execute(
      sql`UPDATE organization_settings SET time_zone = 'Mars/Olympus_Mons' WHERE organization_id = ${ORGANIZATIONS.germanDefault}`,
    );
    // bun-types declares `.rejects.toThrow` as void; capture the rejection.
    const failure = await readOrganizationTimeZone(
      reader,
      ORGANIZATIONS.germanDefault,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      message: expect.stringContaining("Mars/Olympus_Mons is unknown"),
    });
  });
});
