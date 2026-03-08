import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import Elysia from "elysia";

import { db } from "@/api/db";
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
// biome-ignore lint/style/noRestrictedImports: dev-only route; brands session org ID
import { toSafeId } from "@/api/lib/branded-types";
import { getSearchProvider } from "@/api/lib/search/provider";

const VITE_CACHE_DIR = resolve(
  import.meta.dir,
  "../../../../../apps/web/node_modules/.vite",
);

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
      return;
    },
  })
  .post("/seed", async (ctx) => {
    const orgId = ctx.session.activeOrganizationId;
    const userId = ctx.user.id;
    const { seed } = await import("../../../scripts/seed-dev");
    await seed(orgId, userId);
    return { ok: true };
  })
  .post("/clean", async (ctx) => {
    const orgId = ctx.session.activeOrganizationId;

    // Delete in dependency order.
    // 1. Time entries and workspace contacts (org-scoped)
    await db.delete(timeEntries).where(eq(timeEntries.organizationId, orgId));
    await db
      .delete(workspaceContacts)
      .where(eq(workspaceContacts.organizationId, orgId));

    // 2. Property dependencies (no org FK; resolve via
    //    properties -> workspaces). The restrict FK on
    //    dependsOnPropertyId blocks workspace cascade.
    const orgPropertyIds = db
      .select({ id: properties.id })
      .from(properties)
      .innerJoin(workspaces, eq(properties.workspaceId, workspaces.id))
      .where(eq(workspaces.organizationId, orgId));

    await db
      .delete(propertyDependencies)
      .where(inArray(propertyDependencies.propertyId, orgPropertyIds));
    await db
      .delete(propertyDependencies)
      .where(inArray(propertyDependencies.dependsOnPropertyId, orgPropertyIds));

    // 3. Workspaces (cascades entities, versions, fields,
    //    properties, views)
    await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));

    // 4. Contacts
    await db.delete(contacts).where(eq(contacts.organizationId, orgId));

    return { ok: true };
  })
  .post("/rebuild-search", async (ctx) => {
    const orgId = toSafeId<"organization">(ctx.session.activeOrganizationId);
    await getSearchProvider().rebuildIndex(orgId);
    return { ok: true };
  })
  .post("/clear-cache", () => {
    rmSync(VITE_CACHE_DIR, { recursive: true, force: true });
    return { ok: true };
  });
