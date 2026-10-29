import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { rmSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  contacts,
  expenses,
  invoices,
  properties,
  propertyDependencies,
  timeEntries,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { mount, routes } from "@/api/http/route";
import { localDevelopmentGate } from "@/api/lib/deployment-feature-route";
import { readDevOtp } from "@/api/lib/dev-otp-store";
import {
  mintDevSeedSession,
  resolveMemberDevOrganization,
} from "@/api/lib/dev-seed-session-store";
import { defineEndpoint } from "@/api/lib/endpoints";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";
import { getSearchMaintenance } from "@/api/lib/search/provider";

import {
  type FirmKnowledgeJob,
  FirmKnowledgeJobStore,
  type FirmKnowledgeSeedParameters,
  type FirmKnowledgeSeedStatus,
  isReusableFirmKnowledgeJob,
} from "./firm-knowledge-job-store";
import {
  readPublicLawConnection,
  startPublicLawConnection,
} from "./public-law-connection";

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

const getDevApiOrigin = (port: number | undefined): string => {
  if (port === undefined) {
    panic("The dev API server has no listening port.");
  }
  return `http://127.0.0.1:${String(port)}`;
};

const seedStatusEndpoint = defineEndpoint.member({}, () => seedStatus);

const startSeed = defineEndpoint.member({}, ({ session, user }) => {
  const orgId = session.activeOrganizationId;
  const userId = user.id;
  if (!seedInFlight) {
    const startedAt = Temporal.Now.instant().toString({
      fractionalSecondDigits: 3,
    });
    seedStatus = { status: "running", startedAt };
    seedInFlight = (async () => {
      try {
        const { seed } = await import("../../../scripts/seed-dev");
        await seed(orgId, userId);
        seedStatus = {
          status: "succeeded",
          startedAt,
          finishedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
        };
      } catch (error: unknown) {
        seedStatus = {
          status: "failed",
          startedAt,
          finishedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
          message: getErrorMessage(error),
        };
      } finally {
        seedInFlight = null;
      }
    })();
  }

  return seedStatus;
});

const firmKnowledgeStatus = defineEndpoint.member(
  {
    query: v.object({
      jobId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
  },
  ({ query, user }) => {
    const job = firmKnowledgeJobs.getOwned(query.jobId, user.id);
    return job
      ? getFirmKnowledgeJobResponse(job)
      : { jobId: query.jobId, ...IDLE_SEED_STATUS };
  },
);

// Uploads through this same API under a short-lived job session pinned to
// the initiating user and organization. The corpus must travel the real
// upload path to get derivatives and extraction.
const startFirmKnowledgeSeed = defineEndpoint.member(
  {
    body: v.optional(
      v.object({
        incompleteMatterMode: v.optional(
          v.picklist([
            INCOMPLETE_MATTER_MODE.skip,
            INCOMPLETE_MATTER_MODE.replace,
          ]),
        ),
        matters: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(MAX_FIRM_KNOWLEDGE_MATTERS),
          ),
        ),
        organizationId: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        ),
        selectionSeed: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        ),
      }),
    ),
  },
  async (ctx) => {
    const { body, server, session, status, user } = ctx;
    const apiOrigin = getDevApiOrigin(server?.port);
    const userId = user.id;
    // A requested organization is used only after the membership lookup
    // proves the caller belongs to it.
    const organizationId =
      ctx.body?.organizationId === undefined
        ? session.activeOrganizationId
        : await resolveMemberDevOrganization(ctx.body.organizationId, userId);
    if (organizationId === null) {
      return status(403, "Organization membership not found");
    }

    const parameters = {
      matters: body?.matters ?? FIRM_KNOWLEDGE_MATTERS,
      replaceIncomplete:
        body?.incompleteMatterMode === INCOMPLETE_MATTER_MODE.replace,
      ...(body?.selectionSeed === undefined
        ? {}
        : { selectionSeed: body.selectionSeed }),
    } satisfies FirmKnowledgeSeedParameters;

    if (firmKnowledgeInFlight) {
      const job =
        firmKnowledgeJobId === null
          ? null
          : firmKnowledgeJobs.get(firmKnowledgeJobId);
      if (
        job === null ||
        !isReusableFirmKnowledgeJob(job, {
          organizationId,
          parameters,
          userId,
        })
      ) {
        return status(409, "A firm-knowledge seed is already running");
      }

      return getFirmKnowledgeJobResponse(job);
    }

    const startedAt = Temporal.Now.instant().toString({
      fractionalSecondDigits: 3,
    });
    const job = firmKnowledgeJobs.create({
      organizationId,
      parameters,
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
          matters: job.parameters.matters,
          replaceIncomplete: job.parameters.replaceIncomplete,
          ...(job.parameters.selectionSeed === undefined
            ? {}
            : { selectionSeed: job.parameters.selectionSeed }),
        });
        firmKnowledgeJobs.update(job.id, {
          status: "succeeded",
          startedAt,
          finishedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
        } satisfies FirmKnowledgeSeedStatus);
      } catch (error: unknown) {
        firmKnowledgeJobs.update(job.id, {
          status: "failed",
          startedAt,
          finishedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
          message: getErrorMessage(error),
        } satisfies FirmKnowledgeSeedStatus);
      } finally {
        firmKnowledgeInFlight = null;
        firmKnowledgeJobId = null;
      }
    })();

    return getFirmKnowledgeJobResponse(job);
  },
);

const cleanOrganization = defineEndpoint.member(
  {},
  async ({ scopedDb, session }) => {
    const orgId = session.activeOrganizationId;

    await scopedDb(async (tx) => {
      // audit: skip — dev-only org-nuke endpoint; not deployed to prod
      // Delete in dependency order.
      // 1. Billing records, which a matter deletion refuses to take (lines
      //    go with their invoices), and workspace contacts (org-scoped)
      await tx.delete(invoices).where(eq(invoices.organizationId, orgId));
      await tx.delete(expenses).where(eq(expenses.organizationId, orgId));
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
  },
);

const rebuildSearch = defineEndpoint.member({}, async ({ session }) => {
  await getSearchMaintenance().rebuildIndex(session.activeOrganizationId);
  await rebuildSupplementalSearchIndex(session.activeOrganizationId);
  return { ok: true };
});

const clearCache = defineEndpoint.member({}, () => {
  rmSync(VITE_CACHE_DIR, { recursive: true, force: true });
  return { ok: true };
});

/** Local development only: elsewhere these routes answer like absent ones. */
const localDevOnly = localDevelopmentGate;

export const devRoute = routes(
  {
    "/seed": { GET: seedStatusEndpoint, POST: startSeed },
    "/seed-firm-knowledge": {
      GET: firmKnowledgeStatus,
      POST: startFirmKnowledgeSeed,
    },
    "/clean": { POST: cleanOrganization },
    "/rebuild-search": { POST: rebuildSearch },
    "/clear-cache": { POST: clearCache },
    "/public-law-connection": {
      GET: defineEndpoint.member({}, readPublicLawConnection),
      POST: defineEndpoint.member({}, startPublicLawConnection),
    },
  },
  { prefix: "/dev", middleware: [localDevOnly] },
);

// Public local development routes (no auth: the unauthenticated email-OTP
// flow needs them). server.ts registers them only when local development
// access is open; the gate answers 404 for any other caller of the module.
const lastOtp = defineEndpoint.public(
  { query: v.object({ email: v.string() }) },
  ({ query }) => {
    const otp = readDevOtp(query.email);
    if (!otp) {
      return new Response("No OTP", { status: 404 });
    }
    return { otp };
  },
);

export const devPublicRoute = mount(
  [routes({ "/last-otp": { GET: lastOtp } })],
  { prefix: "/dev-public", middleware: [localDevOnly] },
);
