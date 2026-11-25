import { panic } from "better-result";
import { expect } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { member, organization } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createDesktopMatterResolveEndpoint } from "@/api/handlers/desktop-time-entries/resolve";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { desktopScalingAccount } from "@/api/tests/read-scaling/desktop-account";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

/** Ids asked per measured request: the fixed response size. */
const ASKED = 10;

/**
 * The organization holds `size` matters; the desktop asks for a fixed ten:
 * half of them its own, the rest unknown or another organization's. Only the
 * matters asked for may cost anything.
 */
export const measureDesktopMatterResolve = async (fixture: ReadFixture) => {
  const { db, organizationId, userId, size } = fixture;
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const own = Array.from({ length: size }, () => createSafeId<"workspace">());
  const foreign = createSafeId<"workspace">();
  const unknown = Array.from({ length: ASKED / 2 - 1 }, () =>
    createSafeId<"workspace">(),
  );
  const asked = [...own.slice(0, ASKED / 2), foreign, ...unknown];
  let release: (() => Promise<void>) | undefined;
  try {
    await db.insert(organization).values({
      id: otherOrganizationId,
      name: "Other scaling organization",
      slug: otherOrganizationId,
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await db.insert(workspaces).values([
      ...own.map((id, index) => ({
        id,
        organizationId,
        name: `Scaling matter ${String(index).padStart(4, "0")}`,
        reference: `SCALE-${String(index).padStart(4, "0")}`,
      })),
      {
        id: foreign,
        organizationId: otherOrganizationId,
        name: "Other organization matter",
        reference: "OTHER-0001",
      },
    ]);
    await db.execute(sql`GRANT SELECT ON TABLE
      pg_temp."member", pg_temp."workspaces", pg_temp."contacts",
      pg_temp."entities", pg_temp."time_entries",
      pg_temp."workspace_members"
      TO stella`);
    const request = new Request(
      `https://api.example.test/v1/desktop/matter-candidates/resolve?${new URLSearchParams(
        asked.map((id) => ["id", id]),
      ).toString()}`,
    );
    const desktop = await desktopScalingAccount({
      db,
      organizationId,
      userId,
      request,
    });
    release = desktop.release;
    const endpoint = createDesktopMatterResolveEndpoint(
      desktop.authorizeAccount,
    );
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        asTestRaw<Parameters<typeof endpoint.handler>[0]>({
          request,
          query: { id: asked },
          route: "/v1/desktop/matter-candidates/resolve" satisfies ApiRoutePath,
        }),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("Desktop matter resolve requires a successful response");
      }
      // Another organization's matter answers exactly as an unknown one.
      expect(
        response.matters.map((resolution) =>
          resolution.type === "accessible"
            ? resolution.matter.id
            : resolution.type,
        ),
      ).toEqual([
        ...own.slice(0, ASKED / 2),
        ...Array.from({ length: ASKED / 2 }, () => "inaccessible"),
      ]);
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.matters.length,
      };
    });
  } finally {
    await release?.();
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, [...own, foreign]));
    await db.delete(member).where(eq(member.userId, userId));
    await deleteOrganizationsForTest(db, [otherOrganizationId]);
  }
};
