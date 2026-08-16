import { eq, inArray } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { rmSync } from "node:fs";
import path from "node:path";

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
import { readDevOtp } from "@/api/lib/dev-otp-store";
import { mintDevSeedSession } from "@/api/lib/dev-seed-session-store";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";
import { getSearchProvider } from "@/api/lib/search/provider";

import {
  type FirmKnowledgeJob,
  FirmKnowledgeJobStore,
  type FirmKnowledgeSeedStatus,
} from "./firm-knowledge-job-store";

const VITE_CACHE_DIR = path.resolve(
  import.meta.dir,
  "../../../../../apps/web/node_modules/.vite",
);

type SeedStatus = FirmKnowledgeSeedStatus;

const IDLE_SEED_STATUS = { status: "idle" } as const satisfies SeedStatus;

let seedInFlight: Promise<void> | null = null;
let seedStatus: SeedStatus = IDLE_SEED_STATUS;

let firmKnowledgeInFlight: Promise<void> | null = null;
let firmKnowledgeJobId: string | null = null;
const firmKnowledgeJobs = new FirmKnowledgeJobStore();

/** Matters to seed from the Dev menu; the CLI's own default. */
const FIRM_KNOWLEDGE_MATTERS = 15;
const MAX_FIRM_KNOWLEDGE_MATTERS = 50;

const INCOMPLETE_MATTER_MODE = {
  replace: "replace",
  skip: "skip",
} as const;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Seed failed";

const getFirmKnowledgeJobResponse = (job: FirmKnowledgeJob) => ({
  jobId: job.id,
  ...job.status,
});

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
  .get(
    "/seed-firm-knowledge",
    (ctx) => {
      const job = firmKnowledgeJobs.getOwned(ctx.query.jobId, ctx.user.id);
      return job
        ? getFirmKnowledgeJobResponse(job)
        : { jobId: ctx.query.jobId, ...IDLE_SEED_STATUS };
    },
    {
      query: t.Object({
        jobId: t.String({ minLength: 1, maxLength: 128 }),
      }),
    },
  )
  // Uploads through this same API under a short-lived job session pinned to
  // the initiating user and organization. The corpus must travel the real
  // upload path to get derivatives and extraction.
  .post(
    "/seed-firm-knowledge",
    (ctx) => {
      const apiOrigin = new URL(ctx.request.url).origin;
      const organizationId = ctx.session.activeOrganizationId;
      const userId = ctx.user.id;

      if (firmKnowledgeInFlight) {
        const job =
          firmKnowledgeJobId === null
            ? null
            : firmKnowledgeJobs.get(firmKnowledgeJobId);
        if (job?.organizationId !== organizationId || job.userId !== userId) {
          return new Response("A firm-knowledge seed is already running", {
            status: 409,
          });
        }

        return getFirmKnowledgeJobResponse(job);
      }

      const startedAt = new Date().toISOString();
      const job = firmKnowledgeJobs.create({
        organizationId,
        startedAt,
        userId,
      });
      firmKnowledgeJobId = job.id;
      firmKnowledgeInFlight = (async () => {
        try {
          const seedSession = await mintDevSeedSession({
            organizationId,
            userId,
          });
          const { seedFirmKnowledge } =
            await import("../../../scripts/seed-firm-knowledge");
          await seedFirmKnowledge({
            apiOrigin,
            cookie: seedSession.cookie,
            matters: ctx.body?.matters ?? FIRM_KNOWLEDGE_MATTERS,
            replaceIncomplete:
              ctx.body?.incompleteMatterMode === INCOMPLETE_MATTER_MODE.replace,
            ...(ctx.body?.selectionSeed === undefined
              ? {}
              : { selectionSeed: ctx.body.selectionSeed }),
          });
          firmKnowledgeJobs.update(job.id, {
            status: "succeeded",
            startedAt,
            finishedAt: new Date().toISOString(),
          } satisfies FirmKnowledgeSeedStatus);
        } catch (error: unknown) {
          firmKnowledgeJobs.update(job.id, {
            status: "failed",
            startedAt,
            finishedAt: new Date().toISOString(),
            message: getErrorMessage(error),
          } satisfies FirmKnowledgeSeedStatus);
        } finally {
          firmKnowledgeInFlight = null;
          firmKnowledgeJobId = null;
        }
      })();

      return getFirmKnowledgeJobResponse(job);
    },
    {
      body: t.Optional(
        t.Object({
          incompleteMatterMode: t.Optional(
            t.Union([
              t.Literal(INCOMPLETE_MATTER_MODE.skip),
              t.Literal(INCOMPLETE_MATTER_MODE.replace),
            ]),
          ),
          matters: t.Optional(
            t.Integer({ minimum: 1, maximum: MAX_FIRM_KNOWLEDGE_MATTERS }),
          ),
          selectionSeed: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
        }),
      ),
    },
  )
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
      const otp = readDevOtp(query.email);
      if (!otp) {
        return new Response("No OTP", { status: 404 });
      }
      return { otp };
    },
    {
      query: t.Object({ email: t.String() }),
    },
  );
