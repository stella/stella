import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
/**
 * Authorization gate for automated flow runs: an automated run (schedule /
 * file-upload trigger) executes as the definition's author against a root-scoped
 * grant for its workspace, so the start path is the only place that can enforce
 * the author's access to that matter. A file-upload trigger saved with
 * `workspaceIds: null` ("all matters") matches uploads in every matter,
 * including ones the author is not a member of, so the gate must refuse to start
 * there. Driven against a real (PGlite) database so the real
 * `resolveMemberAuthorization` membership rule runs.
 */
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowUploadTriggerIntents,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { insertAutomatedFlowRunWithinCap } from "@/api/lib/flows/automated-run-cap";
import type { FlowStep, FlowTrigger } from "@/api/lib/flows/flow-types";
import { startAutomatedFlowRun } from "@/api/lib/flows/start-automated-flow-run";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testDb: TestDatabase = await getTestDb();
const authorizationDatabase =
  asTestRaw<NonNullable<Parameters<typeof resolveMemberAuthorization>[1]>>(
    testDb,
  );
const capDatabase =
  asTestRaw<
    NonNullable<
      Parameters<typeof insertAutomatedFlowRunWithinCap>[0]["database"]
    >
  >(testDb);

type EnqueuedStep = { runId: string; stepIndex: number };
const enqueuedSteps: EnqueuedStep[] = [];

const AI_STEP: FlowStep = {
  kind: "ai",
  name: "Draft memo",
  prompt: "Draft a short legal memo.",
  includeDocuments: false,
};

// A wildcard file-upload trigger: matches uploads in every matter of the org.
const WILDCARD_UPLOAD_TRIGGER = {
  type: "file-upload",
  workspaceIds: null,
  fileExtensions: null,
} as const satisfies FlowTrigger;

describe("startAutomatedFlowRun authorization gate", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const authorId = mintAuthProviderId<"user">();
  // The author is a member of this matter and a stranger to the other.
  const authorizedWorkspaceId = createSafeId<"workspace">();
  const unauthorizedWorkspaceId = createSafeId<"workspace">();
  const definitionId = createSafeId<"flowDefinition">();
  const entityId = createSafeId<"entity">();
  const retryAt = new Date();
  let uploadTriggerClaimToken: TimestampCasToken | undefined;

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Automated Run Authz Org",
      slug: `automated-authz-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: authorId,
      name: "Flow Author",
      emailVerified: true,
      email: `${authorId}@example.test`,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: authorId,
      role: "member",
      createdAt: new Date(),
    });
    await testDb
      .insert(featureEnrolments)
      .values({ featureId: "flows", organizationId, userId: authorId });
    await testDb.insert(workspaces).values([
      {
        id: authorizedWorkspaceId,
        organizationId,
        clientId: null,
        name: "Author matter",
        reference: "AUTHZ-OK",
      },
      {
        id: unauthorizedWorkspaceId,
        organizationId,
        clientId: null,
        name: "Restricted matter",
        reference: "AUTHZ-NO",
      },
    ]);
    await testDb.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId: authorizedWorkspaceId,
      userId: authorId,
    });
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Wildcard upload flow",
      steps: [AI_STEP],
      trigger: WILDCARD_UPLOAD_TRIGGER,
      enabled: true,
      createdByUserId: authorId,
    });
    await testDb.insert(entities).values({
      id: entityId,
      workspaceId: authorizedWorkspaceId,
      name: "upload.pdf",
    });
    const receipt = await withOrgScopedFixture({
      database: testDb,
      workspaceId: authorizedWorkspaceId,
      fn: async (fixtureTx) =>
        await fixtureTx
          .insert(flowUploadTriggerIntents)
          .values({
            organizationId,
            workspaceId: authorizedWorkspaceId,
            definitionId,
            entityId,
            fileExtension: "pdf",
            retryAt,
          })
          .returning({
            token: timestampCasToken(flowUploadTriggerIntents.retryAt),
          }),
    });
    uploadTriggerClaimToken = receipt.at(0)?.token;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const runsForWorkspace = async (workspaceId: SafeId<"workspace">) =>
    await testDb
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(eq(flowRuns.workspaceId, workspaceId));

  const startForWorkspace = async (workspaceId: SafeId<"workspace">) => {
    await startAutomatedFlowRun(
      {
        definitionId,
        organizationId,
        workspaceId,
        createdByUserId: authorId,
        triggerSource: { type: "file-upload", entityId },
        uploadTriggerClaimToken,
        inputEntityIds: [entityId],
        logContext: { definitionId, workspaceId, trigger: "file-upload" },
      },
      {
        findDefinition: async (args) =>
          await testDb.query.flowDefinitions.findFirst({
            where: {
              id: { eq: args.definitionId },
              organizationId: { eq: args.organizationId },
            },
            columns: {
              id: true,
              name: true,
              steps: true,
              enabled: true,
              trigger: true,
            },
          }),
        featureEnabled: async (principal) =>
          await isBackgroundFeatureEnabled({
            tx: authorizationDatabase,
            organizationId: principal.organizationId,
            userId: principal.userId,
            featureId: "flows",
          }),
        resolveAuthorization: async (args) =>
          await resolveMemberAuthorization(args, authorizationDatabase),
        insertWithinCap: async (input) =>
          await insertAutomatedFlowRunWithinCap({
            ...input,
            database: capDatabase,
          }),
        enqueueStep: async ({ runId, stepIndex }) => {
          enqueuedSteps.push({ runId, stepIndex });
        },
      },
    );
  };

  test("starts the run when the author can access the upload workspace", async () => {
    await startForWorkspace(authorizedWorkspaceId);

    expect(await runsForWorkspace(authorizedWorkspaceId)).toHaveLength(1);
    expect(enqueuedSteps.some((step) => step.stepIndex === 0)).toBe(true);
  });

  test("skips the run when the wildcard trigger fires in a matter the author cannot access", async () => {
    const enqueuedBefore = enqueuedSteps.length;

    await startForWorkspace(unauthorizedWorkspaceId);

    expect(await runsForWorkspace(unauthorizedWorkspaceId)).toHaveLength(0);
    expect(enqueuedSteps).toHaveLength(enqueuedBefore);
  });

  type DeadlineFailureStage = Exclude<
    keyof Parameters<typeof startAutomatedFlowRun>[1],
    "statementTimeoutMs" | "enqueueStep"
  >;
  const deadlineFailureStages = {
    featureEnabled: "featureEnabled",
    findDefinition: "findDefinition",
    resolveAuthorization: "resolveAuthorization",
    insertWithinCap: "insertWithinCap",
    kickoff: "kickoff",
  } as const satisfies Record<DeadlineFailureStage, DeadlineFailureStage>;
  const deadlineInput = {
    definitionId,
    organizationId,
    workspaceId: authorizedWorkspaceId,
    createdByUserId: authorId,
    triggerSource: { type: "file-upload", entityId },
    inputEntityIds: [entityId],
    logContext: { definitionId, workspaceId: authorizedWorkspaceId },
  } satisfies Parameters<typeof startAutomatedFlowRun>[0];
  const successfulDeadlineDependencies = (
    statementTimeoutMs?: number,
  ): Parameters<typeof startAutomatedFlowRun>[1] => ({
    ...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
    findDefinition: async () => ({
      id: definitionId,
      name: "Deadline test flow",
      steps: [AI_STEP],
      enabled: true,
      trigger: WILDCARD_UPLOAD_TRIGGER,
    }),
    featureEnabled: async () => true,
    resolveAuthorization: async () => ({
      memberId: "deadline-test-member",
      email: "deadline-test@example.test",
      role: "member",
      workspace: { id: authorizedWorkspaceId, status: "active" },
      emailVerified: true,
      userDeleted: false,
      enrolledFeatureIds: ["flows"],
      professionalUse: { status: "required" },
    }),
    insertWithinCap: async () => ({ outcome: "started" }),
    enqueueStep: async () => undefined,
    kickoff: async ({ run }) =>
      await run(new AbortController().signal, async () => undefined),
  });
  const failAtDeadlineStage = (
    dependencies: Parameters<typeof startAutomatedFlowRun>[1],
    stage: DeadlineFailureStage,
    failure: unknown,
  ): Parameters<typeof startAutomatedFlowRun>[1] => {
    const reject = async (): Promise<never> => {
      throw failure;
    };
    switch (stage) {
      case "featureEnabled":
        return { ...dependencies, featureEnabled: reject };
      case "findDefinition":
        return { ...dependencies, findDefinition: reject };
      case "resolveAuthorization":
        return { ...dependencies, resolveAuthorization: reject };
      case "insertWithinCap":
        return { ...dependencies, insertWithinCap: reject };
      case "kickoff":
        return { ...dependencies, kickoff: reject };
      default: {
        const unexpected: never = stage;
        return panic(`Unknown deadline failure stage ${String(unexpected)}`);
      }
    }
  };

  test("configured deadlines propagate PostgreSQL cancellation through every boundary", async () => {
    const cancellation = new Error("wrapped transaction failure", {
      cause: Object.assign(new Error("statement timeout"), {
        code: PG_ERROR.QUERY_CANCELED,
      }),
    });
    for (const stage of Object.values(deadlineFailureStages)) {
      const outcome = await startAutomatedFlowRun(
        deadlineInput,
        failAtDeadlineStage(
          successfulDeadlineDependencies(5000),
          stage,
          cancellation,
        ),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(getPgErrorCode(outcome), stage).toBe(PG_ERROR.QUERY_CANCELED);
    }
  });

  test("without a deadline, PostgreSQL cancellation remains a retry outcome", async () => {
    const cancellation = new Error("wrapped transaction failure", {
      cause: Object.assign(new Error("statement timeout"), {
        code: PG_ERROR.QUERY_CANCELED,
      }),
    });
    for (const stage of Object.values(deadlineFailureStages)) {
      expect(
        await startAutomatedFlowRun(
          deadlineInput,
          failAtDeadlineStage(
            successfulDeadlineDependencies(),
            stage,
            cancellation,
          ),
        ),
        stage,
      ).toEqual({ status: "retry" });
    }
  });

  test("configured deadlines keep other failures as retry outcomes", async () => {
    const ordinaryFailure = new Error("ordinary dependency failure");
    for (const stage of Object.values(deadlineFailureStages)) {
      expect(
        await startAutomatedFlowRun(
          deadlineInput,
          failAtDeadlineStage(
            successfulDeadlineDependencies(5000),
            stage,
            ordinaryFailure,
          ),
        ),
        stage,
      ).toEqual({ status: "retry" });
    }
  });
});
