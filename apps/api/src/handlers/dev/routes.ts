import { eq, inArray } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  contacts,
  properties,
  propertyDependencies,
  timeEntries,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { authMacro } from "@/api/lib/auth";
import { popDevOtp } from "@/api/lib/dev-otp-store";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";
import { getSearchProvider } from "@/api/lib/search/provider";

const VITE_CACHE_DIR = resolve(
  import.meta.dir,
  "../../../../../apps/web/node_modules/.vite",
);

type SeedStatus =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "succeeded"; startedAt: string; finishedAt: string }
  | {
      status: "failed";
      startedAt: string;
      finishedAt: string;
      message: string;
    };

let seedInFlight: Promise<void> | null = null;
let seedStatus: SeedStatus = { status: "idle" };

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Seed failed";

export const devRoute = new Elysia({ prefix: "/dev" })
  .use(authMacro)
  .guard({
    validateAuth: true,
    beforeHandle: () => {
      if (!env.isDev) {
        return new Response("Not available", {
          status: 404,
        });
      }
      return undefined;
    },
  })
  .get("/seed", () => seedStatus)
  .post("/seed", (ctx) => {
    const orgId = ctx.session.activeOrganizationId;
    const userId = ctx.user.id;
    if (!seedInFlight) {
      const startedAt = new Date().toISOString();
      seedStatus = { status: "running", startedAt };
      seedInFlight = (async () => {
        try {
          const { seed } = await import("../../../scripts/seed-dev");
          await seed(orgId, userId);
          seedStatus = {
            status: "succeeded",
            startedAt,
            finishedAt: new Date().toISOString(),
          };
        } catch (error: unknown) {
          seedStatus = {
            status: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            message: getErrorMessage(error),
          };
        } finally {
          seedInFlight = null;
        }
      })();
    }

    return seedStatus;
  })
  .post("/clean", async (ctx) => {
    const orgId = ctx.session.activeOrganizationId;

    await ctx.scopedDb(async (tx) => {
      // audit: skip — dev-only org-nuke endpoint; not deployed to prod
      // Delete in dependency order.
      // 1. Time entries and workspace contacts (org-scoped)
      await tx.delete(timeEntries).where(eq(timeEntries.organizationId, orgId));
      await tx
        .delete(workspaceContacts)
        .where(eq(workspaceContacts.organizationId, orgId));

      // 2. Property dependencies (no org FK; resolve via
      //    properties -> workspaces). The restrict FK on
      //    dependsOnPropertyId blocks workspace cascade.
      const orgPropertyIds = tx
        .select({ id: properties.id })
        .from(properties)
        .innerJoin(workspaces, eq(properties.workspaceId, workspaces.id))
        .where(eq(workspaces.organizationId, orgId));

      await tx
        .delete(propertyDependencies)
        .where(inArray(propertyDependencies.propertyId, orgPropertyIds));
      await tx
        .delete(propertyDependencies)
        .where(
          inArray(propertyDependencies.dependsOnPropertyId, orgPropertyIds),
        );

      // 3. Workspaces (cascades entities, versions, fields,
      //    properties, views)
      await tx.delete(workspaces).where(eq(workspaces.organizationId, orgId));

      // 4. Contacts
      await tx.delete(contacts).where(eq(contacts.organizationId, orgId));
    });

    return { ok: true };
  })
  .post("/rebuild-search", async (ctx) => {
    await getSearchProvider().rebuildIndex(ctx.session.activeOrganizationId);
    await rebuildSupplementalSearchIndex(ctx.session.activeOrganizationId);
    return { ok: true };
  })
  .post("/clear-cache", () => {
    rmSync(VITE_CACHE_DIR, { recursive: true, force: true });
    return { ok: true };
  });

// Public dev-only routes (no auth — needed for the unauthenticated
// email-OTP flow). Returns 404 outside dev so this never exists in
// the production API surface.
export const devPublicRoute = new Elysia({ prefix: "/dev-public" })
  .guard({
    beforeHandle: () => {
      if (!env.isDev) {
        return new Response("Not available", { status: 404 });
      }
      return undefined;
    },
  })
  .get(
    "/last-otp",
    ({ query }) => {
      const otp = popDevOtp(query.email);
      if (!otp) {
        return new Response("No OTP", { status: 404 });
      }
      return { otp };
    },
    {
      query: t.Object({ email: t.String() }),
    },
  );
