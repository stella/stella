/**
 * Adversarial runtime isolation suite for Document Review (lists/grids/sources,
 * claim verifications/reviews/comments, document review runs/findings), Matter
 * Documents & Versions, and Workflow/Template runs against a real PGlite DB.
 *
 * Drives the real production handler + membership-scoped RLS pipeline
 * (`resolveMemberAuthorization`, `admitsWorkspaceStatus`,
 * `createMembershipScopedDb`, `createMembershipSafeDb`, and `createSafeHandler`
 * permission enforcement) across five adversarial boundaries:
 *
 * 1. Cross-tenant (Org A owner -> Org B review lists, items, sources,
 *    verifications, claims, comments, document review runs/findings, matter
 *    documents/versions, workflows/flow runs, and templates/versions)
 * 2. Intra-org ethical wall (Org A member assigned to Matter 1 -> unassigned
 *    Matter 2 across all surfaces, plus cross-matter ID confusion for both
 *    member and owner)
 * 3. Archived matter write freeze (writes rejected on archived matter even for
 *    assigned member and org owner)
 * 4. External collaborator read-only boundary (assigned external role can read
 *    assigned matter, denied every write and denied unassigned matters)
 * 5. Live membership revocation (deleting `workspace_members` row immediately
 *    revokes both route-gate and membership-scoped RLS access)
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
  entityVersions,
  fields,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  legalListClaims,
  legalListColumns,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListSections,
  legalListVerificationRuns,
  legalReaderAnnotations,
  properties,
  templates,
  templateVersions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { env } from "@/api/env";
import decideDocumentReviewFinding from "@/api/handlers/document-reviews/decide-finding";
import exportDocumentReviewRun from "@/api/handlers/document-reviews/export-run";
import listDocumentReviewRuns from "@/api/handlers/document-reviews/list-runs";
import readDocumentReviewRun from "@/api/handlers/document-reviews/read-run";
import readEntityById from "@/api/handlers/entities/get";
import moveEntity from "@/api/handlers/entities/move";
import readVersionById from "@/api/handlers/entities/versions/get";
import updateVersionLabel from "@/api/handlers/entities/versions/label/update";
import readVersions from "@/api/handlers/entities/versions/list";
import restoreVersion from "@/api/handlers/entities/versions/restore";
import deleteFlowDefinition from "@/api/handlers/flows/delete";
import getFlowDefinition from "@/api/handlers/flows/get";
import cancelFlowRun from "@/api/handlers/flows/runs/cancel";
import getFlowRun from "@/api/handlers/flows/runs/get";
import listFlowRuns from "@/api/handlers/flows/runs/list";
import reviewFlowRun from "@/api/handlers/flows/runs/review";
import startFlowRunHandler from "@/api/handlers/flows/runs/start";
import updateFlowDefinition from "@/api/handlers/flows/update";
import createColumn from "@/api/handlers/lists/columns/create";
import readListById from "@/api/handlers/lists/get";
import listGraphNodes from "@/api/handlers/lists/graph/nodes/list";
import readItemActivity from "@/api/handlers/lists/items/activity/list";
import createItemComment from "@/api/handlers/lists/items/comments/create";
import readListItems from "@/api/handlers/lists/items/list";
import reviewItem from "@/api/handlers/lists/items/reviews/update";
import createItemSource from "@/api/handlers/lists/items/sources/create";
import readItemSources from "@/api/handlers/lists/items/sources/list";
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
import updateItem from "@/api/handlers/lists/items/update";
import readLists from "@/api/handlers/lists/list";
import readSourceDocumentKinds from "@/api/handlers/lists/source-documents/list";
import updateList from "@/api/handlers/lists/update";
import createClaimComment from "@/api/handlers/lists/verifications/claim-comments/create";
import deleteClaimComment from "@/api/handlers/lists/verifications/claim-comments/delete";
import listClaimComments from "@/api/handlers/lists/verifications/claim-comments/list";
import updateClaimComment from "@/api/handlers/lists/verifications/claim-comments/update";
import createClaimReview from "@/api/handlers/lists/verifications/claim-reviews/create";
import listClaimReviews from "@/api/handlers/lists/verifications/claim-reviews/list";
import readVerification from "@/api/handlers/lists/verifications/get";
import readLatestVerifications from "@/api/handlers/lists/verifications/latest/list";
import readVerifications from "@/api/handlers/lists/verifications/list";
import getTemplate from "@/api/handlers/templates/get";
import updateTemplate from "@/api/handlers/templates/update";
import listTemplateVersions from "@/api/handlers/templates/versions/list";
import { HttpStatusResponse, status } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import {
  admitsWorkspaceStatus,
  type WorkspaceStatusAccess,
} from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  type DocumentReviewFindingPayload,
  type DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: PGlite database bootstrap and multi-tenant document review fixture seeding
setDefaultTimeout(60_000);

const testState = createTestState({ file: import.meta.path, config: env });

const FIXED_CREATED_AT = new Date("2026-06-15T10:00:00.000Z");
const CONTENT_SHA256 = "a".repeat(64);
const REFERENCE_POSITION_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE_PASSAGE_ID = "66666666-6666-4666-8666-666666666666";

type RoleName = "owner" | "admin" | "member" | "external";

type Actor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  role: RoleName;
  email: string;
};

type MatterBundle = {
  workspaceId: SafeId<"workspace">;
  folderId: SafeId<"entity">;
  docId: SafeId<"entity">;
  docVersionId: SafeId<"entityVersion">;
  fileFieldId: SafeId<"field">;
  propId: SafeId<"property">;
  extraPropId: SafeId<"property">;
  listId: SafeId<"legalList">;
  sectionId: SafeId<"legalListSection">;
  itemEntityId: SafeId<"entity">;
  itemSourceId: SafeId<"legalListItemSource">;
  verifRunId: SafeId<"legalListVerificationRun">;
  claimId: SafeId<"legalListClaim">;
  claimCommentId: SafeId<"legalReaderAnnotation">;
  reviewRunId: SafeId<"documentReviewRun">;
  findingId: SafeId<"documentReviewFinding">;
  flowRunId: SafeId<"flowRun">;
  flowReviewRunId: SafeId<"flowRun">;
};

type Fixture = {
  orgA: SafeId<"organization">;
  orgB: SafeId<"organization">;
  ownerA: Actor;
  memberA: Actor;
  collabA: Actor;
  ownerB: Actor;
  matterA_accessible: MatterBundle;
  matterA_restricted: MatterBundle;
  matterA_archived: MatterBundle;
  matterB: MatterBundle;
  flowDefA: SafeId<"flowDefinition">;
  flowDefB: SafeId<"flowDefinition">;
  templateA: SafeId<"template">;
  templateVersionA: SafeId<"templateVersion">;
  templateB: SafeId<"template">;
  templateVersionB: SafeId<"templateVersion">;
};

let testDb: TestDatabase;
let fx: Fixture;

const noopAudit: AuditRecorder = async () => undefined;

const isHttpError = (value: unknown): value is HttpStatusResponse =>
  value instanceof HttpStatusResponse;

const expectDenied = (
  result: unknown,
  allowedCodes: readonly number[],
  label: string,
) => {
  expect({
    label,
    isError: isHttpError(result),
    code: isHttpError(result) ? result.code : 200,
    allowed: isHttpError(result) && allowedCodes.includes(result.code),
  }).toEqual({
    label,
    isError: true,
    code: isHttpError(result) ? result.code : 200,
    allowed: true,
  });
};

const expectOk = (result: unknown, label: string) => {
  expect({
    label,
    isError: isHttpError(result),
    code: isHttpError(result) ? result.code : 200,
  }).toEqual({
    label,
    isError: false,
    code: 200,
  });
};

const multiOrgFeatureGrants = (
  organizationIds: readonly SafeId<"organization">[],
): typeof env.API_FEATURE_ACCESS_GRANTS => ({
  [LEGAL_LISTS_FEATURE_ID]: organizationIds.map((organizationId) => ({
    type: "organization" as const,
    organizationId,
  })),
  [LIST_VERIFICATION_FEATURE_ID]: organizationIds.map((organizationId) => ({
    type: "organization" as const,
    organizationId,
  })),
});

const buildFeatureSnapshot = (actor: Actor) => {
  const grants = multiOrgFeatureGrants([fx.orgA, fx.orgB]);
  return createFeatureAccessSnapshot({
    organizationId: actor.organizationId,
    userId: actor.userId,
    decisions: new Map(
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
        (featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            organizationId: actor.organizationId,
            userId: actor.userId,
            membership: true,
            user: { email: actor.email, emailVerified: true },
            grants,
          }),
        ],
      ),
    ),
  });
};

const buildActorDbs = (actor: Actor) => {
  const featureAccessSnapshot = buildFeatureSnapshot(actor);
  const identity = {
    organizationId: actor.organizationId,
    serverValidatedWorkspaceIds: [],
    userId: actor.userId,
    featureAccessSnapshot,
  };
  return {
    featureAccessSnapshot,
    scopedDb: asTestRaw<ScopedDb>(createMembershipScopedDb(testDb, identity)),
    safeDb: asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity)),
  };
};

type AnySafeHandler<TContext> = {
  readonly config: {
    readonly contract: string;
    readonly workspaceStatus?: WorkspaceStatusAccess;
  };
  readonly handler: (ctx: TContext) => Promise<unknown>;
};

const invokeWorkspaceHandler = async <TContext>(
  actor: Actor,
  handler: AnySafeHandler<TContext>,
  workspaceId: SafeId<"workspace">,
  input: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } = {},
  options: { bypassRouteGate?: boolean } = {},
): Promise<unknown> => {
  if (!options.bypassRouteGate) {
    const auth = await resolveMemberAuthorization(
      {
        organizationId: actor.organizationId,
        userId: actor.userId,
        workspaceId,
        authentication: { kind: "credential" },
      },
      asTestRaw(testDb),
    );
    const admitted = handler.config.workspaceStatus ?? "active";
    if (!admitsWorkspaceStatus(auth?.workspace?.status, admitted)) {
      return status(404, { message: "Workspace not found" });
    }
  }

  const { featureAccessSnapshot, safeDb, scopedDb } = buildActorDbs(actor);
  const ctx = createTestHandlerContext<TContext>({
    workspaceId,
    memberRole: sessionMemberRole(actor.role),
    session: { activeOrganizationId: actor.organizationId },
    user: { id: actor.userId, email: actor.email },
    safeDb,
    scopedDb,
    audit: noopAudit,
    featureAccessSnapshot,
    params: { workspaceId, ...input.params },
    query: input.query ?? {},
    body: input.body ?? {},
  });
  return await handler.handler(ctx);
};

const invokeOrgHandler = async <TContext>(
  actor: Actor,
  handler: AnySafeHandler<TContext>,
  input: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> => {
  const { featureAccessSnapshot, safeDb, scopedDb } = buildActorDbs(actor);
  const ctx = createTestHandlerContext<TContext>({
    memberRole: sessionMemberRole(actor.role),
    session: { activeOrganizationId: actor.organizationId },
    user: { id: actor.userId, email: actor.email },
    safeDb,
    scopedDb,
    audit: noopAudit,
    featureAccessSnapshot,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
  });
  return await handler.handler(ctx);
};

const createOrgAndOwner = async (
  firmName: string,
): Promise<{ organizationId: SafeId<"organization">; owner: Actor }> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb.insert(user).values({
    id: userId,
    name: `${firmName} Owner`,
    email,
    emailVerified: true,
  });
  await testDb.insert(organization).values({
    id: organizationId,
    name: firmName,
    slug: `firm-${organizationId}`,
    createdAt: FIXED_CREATED_AT,
  });
  await recordNewOrganizationAccessState(testDb, {
    organizationId,
    now: FIXED_CREATED_AT,
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: FIXED_CREATED_AT,
  });
  return {
    organizationId,
    owner: { organizationId, userId, role: "owner", email },
  };
};

const addOrgMember = async (
  organizationId: SafeId<"organization">,
  name: string,
  role: RoleName,
): Promise<Actor> => {
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role,
    createdAt: FIXED_CREATED_AT,
  });
  return { organizationId, userId, role, email };
};

const buildReviewBasis = (
  workspaceId: SafeId<"workspace">,
  entityId: SafeId<"entity">,
  fileFieldId: SafeId<"field">,
  entityVersionId: SafeId<"entityVersion">,
): DocumentReviewRunBasis => ({
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Adversarial review playbook",
      positions: {
        version: 3,
        items: [
          {
            mode: "graded",
            sourceId: REFERENCE_POSITION_ID,
            issue: "Governing law",
            severity: "high",
            standard: {
              source: "reference",
              termKind: "parameter",
              passages: [
                {
                  id: REFERENCE_PASSAGE_ID,
                  workspaceId,
                  entityId,
                  fileFieldId,
                  entityVersionId,
                  blockId: "para-1",
                },
              ],
            },
            ask: { mode: "auto" },
            enabled: true,
          },
        ],
      },
      scope: null,
    },
  },
  perspective: { type: "party", role: "Buyer", name: null },
  references: [],
});

const buildFindingPayload = (
  label: string,
  fileFieldId: SafeId<"field">,
): DocumentReviewFindingPayload => ({
  finding: {
    positionId: REFERENCE_POSITION_ID,
    issue: "Governing law",
    severity: "high",
    standardSource: "reference",
    verdict: "deviation",
    delta: { kind: "language" },
    extracted: null,
    consensus: "single",
    rationale: `Secret rationale for ${label}`,
    explanation: { type: "comparison", text: `Secret comparison for ${label}` },
    citations: [{ blockId: "para-1", text: `Cited clause in ${label}` }],
    referenceCitations: [
      {
        fileFieldId,
        passages: [{ id: REFERENCE_PASSAGE_ID, blockId: "para-1" }],
      },
    ],
    fix: null,
  },
});

const seedMatterBundle = async ({
  organizationId,
  owner,
  label,
  status: matterStatus,
  flowDefinitionId,
}: {
  organizationId: SafeId<"organization">;
  owner: Actor;
  label: string;
  status: "active" | "archived";
  flowDefinitionId: SafeId<"flowDefinition">;
}): Promise<MatterBundle> => {
  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: `${label} Matter`,
    reference: `REF-${label}-${workspaceId.slice(0, 6)}`,
    visibility: "admins_and_assigned",
    status: matterStatus,
    createdAt: FIXED_CREATED_AT,
  });

  // Matter folder + document + version + file field + properties
  const folderId = createSafeId<"entity">();
  const docId = createSafeId<"entity">();
  const docVersionId = createSafeId<"entityVersion">();
  const propId = createSafeId<"property">();
  const extraPropId = createSafeId<"property">();
  const filePropId = createSafeId<"property">();
  const fileFieldId = createSafeId<"field">();

  await testDb.insert(properties).values([
    {
      id: propId,
      workspaceId,
      name: `${label} Summary`,
      status: "fresh",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      createdAt: FIXED_CREATED_AT,
    },
    {
      id: extraPropId,
      workspaceId,
      name: `${label} Extra Column`,
      status: "fresh",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      createdAt: FIXED_CREATED_AT,
    },
    {
      id: filePropId,
      workspaceId,
      name: "File",
      status: "fresh",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      createdAt: FIXED_CREATED_AT,
    },
  ]);

  await testDb.insert(entities).values([
    {
      id: folderId,
      workspaceId,
      name: `${label} Folder`,
      kind: "folder",
      createdBy: owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
    {
      id: docId,
      workspaceId,
      name: `${label} Agreement.docx`,
      kind: "document",
      createdBy: owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
  ]);

  await testDb.insert(entityVersions).values({
    id: docVersionId,
    entityId: docId,
    workspaceId,
    versionNumber: 1,
    stamp: "v1",
    label: `${label} initial draft`,
    createdBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
  });

  await testDb
    .update(entities)
    .set({ currentVersionId: docVersionId })
    .where(eq(entities.id, docId));

  await testDb.insert(fields).values({
    id: fileFieldId,
    workspaceId,
    propertyId: filePropId,
    entityVersionId: docVersionId,
    content: { version: 1, type: "text", value: `${label}-agreement.docx` },
  });

  // Legal list + section + column + item + source
  const listId = createSafeId<"legalList">();
  const sectionId = createSafeId<"legalListSection">();
  const columnId = createSafeId<"legalListColumn">();
  const itemEntityId = createSafeId<"entity">();
  const itemSourceId = createSafeId<"legalListItemSource">();

  await testDb.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: `${label} Chronology List`,
    status: "active",
    createdBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalListSections).values({
    id: sectionId,
    workspaceId,
    listId,
    name: `${label} Section 1`,
    position: "a0",
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalListColumns).values({
    id: columnId,
    workspaceId,
    listId,
    propertyId: propId,
    position: 0,
    required: false,
    createdAt: FIXED_CREATED_AT,
  });

  await testDb.insert(entities).values({
    id: itemEntityId,
    workspaceId,
    name: `${label} Fact Item`,
    kind: "task",
    createdBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalListItems).values({
    entityId: itemEntityId,
    workspaceId,
    listId,
    sectionId,
    position: "a0",
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalListItemSources).values({
    id: itemSourceId,
    workspaceId,
    listId,
    itemEntityId,
    sourceEntityId: docId,
    sourceEntityVersionId: docVersionId,
    locator: { type: "document" },
    quote: `Secret quote from ${label}`,
    createdBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  // Verification run + claim + claim comment
  const verifRunId = createSafeId<"legalListVerificationRun">();
  const claimId = createSafeId<"legalListClaim">();
  const claimCommentId = createSafeId<"legalReaderAnnotation">();

  await testDb.insert(legalListVerificationRuns).values({
    id: verifRunId,
    organizationId,
    workspaceId,
    entityId: docId,
    fileFieldId,
    entityVersionId: docVersionId,
    contentSha256: CONTENT_SHA256,
    status: "completed",
    evidence: { listId, facts: [] },
    requestedBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
    startedAt: FIXED_CREATED_AT,
    finishedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalListClaims).values({
    id: claimId,
    workspaceId,
    runId: verifRunId,
    position: 0,
    type: "fact",
    framing: "asserted",
    state: "nocover",
    text: `Secret claim text in ${label}`,
    anchor: { type: "docx-block", blockId: "p1", start: 0, end: 20 },
    createdAt: FIXED_CREATED_AT,
  });

  await testDb.insert(legalReaderAnnotations).values({
    id: claimCommentId,
    organizationId,
    userId: owner.userId,
    workspaceId,
    targetType: "verification-claim",
    targetId: claimId,
    verificationRunId: verifRunId,
    verificationClaimId: claimId,
    kind: "comment",
    blockAnchorId: "p1",
    startOffset: 0,
    endOffset: 20,
    quote: `Secret claim text in ${label}`,
    body: `Secret comment in ${label}`,
    visibility: "shared",
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  });

  // Document review run + finding
  const reviewRunId = createSafeId<"documentReviewRun">();
  const findingId = createSafeId<"documentReviewFinding">();

  await testDb.insert(documentReviewRuns).values({
    id: reviewRunId,
    organizationId,
    workspaceId,
    entityId: docId,
    fileFieldId,
    entityVersionId: docVersionId,
    contentSha256: CONTENT_SHA256,
    basis: buildReviewBasis(workspaceId, docId, fileFieldId, docVersionId),
    status: "completed",
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
    total: 1,
    completed: 1,
    requestedBy: owner.userId,
    createdAt: FIXED_CREATED_AT,
    startedAt: FIXED_CREATED_AT,
    finishedAt: FIXED_CREATED_AT,
  });

  await testDb.insert(documentReviewFindings).values({
    id: findingId,
    organizationId,
    workspaceId,
    runId: reviewRunId,
    entityId: docId,
    fileFieldId,
    entityVersionId: docVersionId,
    positionId: REFERENCE_POSITION_ID,
    positionTitle: `Governing law (${label})`,
    outcome: "deviation",
    payload: buildFindingPayload(label, fileFieldId),
    decision: DOCUMENT_REVIEW_DECISION.OPEN,
    createdAt: FIXED_CREATED_AT,
  });

  // Workflow runs (one running for cancel, one awaiting_review for review gate)
  const flowDefSnapshot = {
    name: `${label} Flow`,
    steps: [
      {
        kind: "review-gate" as const,
        name: "Approve",
        instructions: `Review ${label}`,
      },
    ],
  };

  const flowRunId = createSafeId<"flowRun">();
  const runningRows = buildFlowRunRows({
    runId: flowRunId,
    workspaceId,
    definitionId: flowDefinitionId,
    definition: flowDefSnapshot,
    triggerSource: { type: "manual", userId: owner.userId },
    inputEntityIds: [docId],
  });
  await testDb.insert(flowRuns).values({
    ...runningRows.run,
    status: "running",
    startedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  await testDb.insert(flowRunSteps).values(
    runningRows.steps.map((step) => ({
      ...step,
      status: "running" as const,
      startedAt: FIXED_CREATED_AT,
      createdAt: FIXED_CREATED_AT,
    })),
  );

  const flowReviewRunId = createSafeId<"flowRun">();
  const reviewRows = buildFlowRunRows({
    runId: flowReviewRunId,
    workspaceId,
    definitionId: flowDefinitionId,
    definition: flowDefSnapshot,
    triggerSource: { type: "manual", userId: owner.userId },
    inputEntityIds: [docId],
  });
  await testDb.insert(flowRuns).values({
    ...reviewRows.run,
    status: "awaiting_review",
    startedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  await testDb.insert(flowRunSteps).values(
    reviewRows.steps.map((step) => ({
      ...step,
      status: "awaiting_review" as const,
      startedAt: FIXED_CREATED_AT,
      createdAt: FIXED_CREATED_AT,
    })),
  );

  return {
    workspaceId,
    folderId,
    docId,
    docVersionId,
    fileFieldId,
    propId,
    extraPropId,
    listId,
    sectionId,
    itemEntityId,
    itemSourceId,
    verifRunId,
    claimId,
    claimCommentId,
    reviewRunId,
    findingId,
    flowRunId,
    flowReviewRunId,
  };
};

testState.beforeAll(async () => {
  testDb = await getTestDb();

  const firmA = await createOrgAndOwner("Firm Alpha");
  const firmB = await createOrgAndOwner("Firm Beta");

  const memberA = await addOrgMember(
    firmA.organizationId,
    "Alpha Member",
    "member",
  );
  const collabA = await addOrgMember(
    firmA.organizationId,
    "Alpha External",
    "external",
  );

  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig(
    "API_FEATURE_ACCESS_GRANTS",
    multiOrgFeatureGrants([firmA.organizationId, firmB.organizationId]),
  );

  // Flow definitions per org
  const flowDefA = createSafeId<"flowDefinition">();
  const flowDefB = createSafeId<"flowDefinition">();
  const baseSteps = [
    {
      kind: "review-gate" as const,
      name: "Approve",
      instructions: "Confirm document review",
    },
  ];
  await testDb.insert(flowDefinitions).values([
    {
      id: flowDefA,
      organizationId: firmA.organizationId,
      name: "Org A Review Flow",
      steps: baseSteps,
      trigger: { type: "manual" },
      enabled: true,
      createdByUserId: firmA.owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
    {
      id: flowDefB,
      organizationId: firmB.organizationId,
      name: "Org B Secret Flow",
      steps: baseSteps,
      trigger: { type: "manual" },
      enabled: true,
      createdByUserId: firmB.owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
  ]);

  // Templates + template versions per org
  const templateA = createSafeId<"template">();
  const templateVersionA = createSafeId<"templateVersion">();
  const templateB = createSafeId<"template">();
  const templateVersionB = createSafeId<"templateVersion">();

  await testDb.insert(templates).values([
    {
      id: templateA,
      organizationId: firmA.organizationId,
      name: "Org A NDA Template",
      fileName: "nda-a.docx",
      s3Key: `${firmA.organizationId}/templates/${templateA}/v1.docx`,
      scanState: "scanned",
      sizeBytes: 2048,
      fieldCount: 2,
      currentVersion: 1,
      createdBy: firmA.owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
    {
      id: templateB,
      organizationId: firmB.organizationId,
      name: "Org B Confidential Template",
      fileName: "nda-b.docx",
      s3Key: `${firmB.organizationId}/templates/${templateB}/v1.docx`,
      scanState: "scanned",
      sizeBytes: 2048,
      fieldCount: 2,
      currentVersion: 1,
      createdBy: firmB.owner.userId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    },
  ]);

  await testDb.insert(templateVersions).values([
    {
      id: templateVersionA,
      organizationId: firmA.organizationId,
      templateId: templateA,
      version: 1,
      s3Key: `${firmA.organizationId}/templates/${templateA}/v1.docx`,
      scanState: "scanned",
      fieldCount: 2,
      createdBy: firmA.owner.userId,
      createdAt: FIXED_CREATED_AT,
    },
    {
      id: templateVersionB,
      organizationId: firmB.organizationId,
      templateId: templateB,
      version: 1,
      s3Key: `${firmB.organizationId}/templates/${templateB}/v1.docx`,
      scanState: "scanned",
      fieldCount: 2,
      createdBy: firmB.owner.userId,
      createdAt: FIXED_CREATED_AT,
    },
  ]);

  const matterA_accessible = await seedMatterBundle({
    organizationId: firmA.organizationId,
    owner: firmA.owner,
    label: "Alpha-Open",
    status: "active",
    flowDefinitionId: flowDefA,
  });
  const matterA_restricted = await seedMatterBundle({
    organizationId: firmA.organizationId,
    owner: firmA.owner,
    label: "Alpha-Restricted",
    status: "active",
    flowDefinitionId: flowDefA,
  });
  const matterA_archived = await seedMatterBundle({
    organizationId: firmA.organizationId,
    owner: firmA.owner,
    label: "Alpha-Archived",
    status: "archived",
    flowDefinitionId: flowDefA,
  });
  const matterB = await seedMatterBundle({
    organizationId: firmB.organizationId,
    owner: firmB.owner,
    label: "Beta-Secret",
    status: "active",
    flowDefinitionId: flowDefB,
  });

  // Assign memberA to matterA_accessible & matterA_archived; collabA to matterA_accessible only
  await testDb.insert(workspaceMembers).values([
    {
      workspaceId: matterA_accessible.workspaceId,
      userId: memberA.userId,
      createdAt: FIXED_CREATED_AT,
    },
    {
      workspaceId: matterA_archived.workspaceId,
      userId: memberA.userId,
      createdAt: FIXED_CREATED_AT,
    },
    {
      workspaceId: matterA_accessible.workspaceId,
      userId: collabA.userId,
      createdAt: FIXED_CREATED_AT,
    },
  ]);

  fx = {
    orgA: firmA.organizationId,
    orgB: firmB.organizationId,
    ownerA: firmA.owner,
    memberA,
    collabA,
    ownerB: firmB.owner,
    matterA_accessible,
    matterA_restricted,
    matterA_archived,
    matterB,
    flowDefA,
    flowDefB,
    templateA,
    templateVersionA,
    templateB,
    templateVersionB,
  };
});

afterAll(async () => {
  await releaseTestDb();
});

describe("document review, matter documents & workflow adversarial runtime isolation", () => {
  describe("1. Cross-tenant isolation (Org A owner -> Org B resources)", () => {
    test("Org A owner is denied all Org B list, verification, review, document, and flow endpoints at route gate", async () => {
      const b = fx.matterB;

      // Positive authorized controls: Org B owner genuinely receives Org B data
      const ownerBLists = await invokeWorkspaceHandler(
        fx.ownerB,
        readLists,
        b.workspaceId,
      );
      expectOk(ownerBLists, "authorized control: ownerB readLists");
      expect(JSON.stringify(ownerBLists)).toContain("Beta-Secret");

      const ownerBVerif = await invokeWorkspaceHandler(
        fx.ownerB,
        readVerification,
        b.workspaceId,
        { params: { runId: b.verifRunId } },
      );
      expectOk(ownerBVerif, "authorized control: ownerB readVerification");
      expect(JSON.stringify(ownerBVerif)).toContain("Beta-Secret");

      const ownerBReview = await invokeWorkspaceHandler(
        fx.ownerB,
        readDocumentReviewRun,
        b.workspaceId,
        { params: { runId: b.reviewRunId } },
      );
      expectOk(
        ownerBReview,
        "authorized control: ownerB readDocumentReviewRun",
      );
      expect(JSON.stringify(ownerBReview)).toContain(b.findingId);

      const ownerBDoc = await invokeWorkspaceHandler(
        fx.ownerB,
        readEntityById,
        b.workspaceId,
        { params: { entityId: b.docId } },
      );
      expectOk(ownerBDoc, "authorized control: ownerB readEntityById");
      expect(JSON.stringify(ownerBDoc)).toContain("Beta-Secret");

      const ownerBFlowRuns = await invokeWorkspaceHandler(
        fx.ownerB,
        listFlowRuns,
        b.workspaceId,
        {},
      );
      expectOk(ownerBFlowRuns, "authorized control: ownerB listFlowRuns");
      expect(JSON.stringify(ownerBFlowRuns)).toContain(b.flowRunId);

      expectOk(
        await invokeOrgHandler(fx.ownerB, getFlowDefinition, {
          params: { flowId: fx.flowDefB },
        }),
        "authorized control: ownerB getFlowDefinition",
      );
      expectOk(
        await invokeOrgHandler(fx.ownerB, getTemplate, {
          params: { templateId: fx.templateB },
        }),
        "authorized control: ownerB getTemplate",
      );
      const cases: readonly [string, () => Promise<unknown>][] = [
        [
          "readLists",
          async () =>
            await invokeWorkspaceHandler(fx.ownerA, readLists, b.workspaceId),
        ],
        [
          "readListById",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readListById,
              b.workspaceId,
              {
                params: { listId: b.listId },
              },
            ),
        ],
        [
          "readListItems",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readListItems,
              b.workspaceId,
              {
                params: { listId: b.listId },
              },
            ),
        ],
        [
          "updateList",
          async () =>
            await invokeWorkspaceHandler(fx.ownerA, updateList, b.workspaceId, {
              body: { id: b.listId, name: "Hijacked" },
            }),
        ],
        [
          "readVerification",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readVerification,
              b.workspaceId,
              {
                params: { runId: b.verifRunId },
              },
            ),
        ],
        [
          "listClaimComments",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              listClaimComments,
              b.workspaceId,
              {
                query: { runId: b.verifRunId, claimId: b.claimId },
              },
            ),
        ],
        [
          "listDocumentReviewRuns",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              listDocumentReviewRuns,
              b.workspaceId,
              {
                query: { entityId: b.docId, fileFieldId: b.fileFieldId },
              },
            ),
        ],
        [
          "readDocumentReviewRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readDocumentReviewRun,
              b.workspaceId,
              {
                params: { runId: b.reviewRunId },
              },
            ),
        ],
        [
          "decideDocumentReviewFinding",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              decideDocumentReviewFinding,
              b.workspaceId,
              {
                params: { findingId: b.findingId },
                body: { decision: "accepted" },
              },
            ),
        ],
        [
          "readEntityById",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readEntityById,
              b.workspaceId,
              {
                params: { entityId: b.docId },
              },
            ),
        ],
        [
          "readVersions",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readVersions,
              b.workspaceId,
              {
                params: { entityId: b.docId },
              },
            ),
        ],
        [
          "updateVersionLabel",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              updateVersionLabel,
              b.workspaceId,
              {
                params: { entityId: b.docId, versionId: b.docVersionId },
                body: { label: "Tampered" },
              },
            ),
        ],
        [
          "listFlowRuns",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              listFlowRuns,
              b.workspaceId,
              {},
            ),
        ],
        [
          "getFlowRun",
          async () =>
            await invokeWorkspaceHandler(fx.ownerA, getFlowRun, b.workspaceId, {
              params: { runId: b.flowRunId },
            }),
        ],
        [
          "cancelFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              cancelFlowRun,
              b.workspaceId,
              {
                params: { runId: b.flowRunId },
              },
            ),
        ],
      ];

      for (const [label, run] of cases) {
        expectDenied(await run(), [404], `cross-tenant route gate: ${label}`);
      }
    });

    test("Direct membership-scoped RLS blocks Org A owner even if route gate is bypassed", async () => {
      const b = fx.matterB;
      const bypass = { bypassRouteGate: true };

      // List reads return empty or 404
      const listsRes = await invokeWorkspaceHandler(
        fx.ownerA,
        readLists,
        b.workspaceId,
        {},
        bypass,
      );
      expectOk(listsRes, "direct RLS readLists returns empty");
      expect(JSON.stringify(listsRes)).not.toContain("Beta-Secret");

      const graphRes = await invokeWorkspaceHandler(
        fx.ownerA,
        listGraphNodes,
        b.workspaceId,
        { query: { text: "Beta-Secret" } },
        bypass,
      );
      expectOk(graphRes, "direct RLS listGraphNodes returns empty");
      expect(JSON.stringify(graphRes)).not.toContain("Beta-Secret");

      const flowRunsRes = await invokeWorkspaceHandler(
        fx.ownerA,
        listFlowRuns,
        b.workspaceId,
        {},
        bypass,
      );
      expectOk(flowRunsRes, "direct RLS listFlowRuns returns empty");
      expect(JSON.stringify(flowRunsRes)).not.toContain(b.flowRunId);

      // Single-resource reads and writes fail with 404/400/403
      const directDenied: readonly [string, () => Promise<unknown>][] = [
        [
          "readListById",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readListById,
              b.workspaceId,
              { params: { listId: b.listId } },
              bypass,
            ),
        ],
        [
          "updateList",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              updateList,
              b.workspaceId,
              { body: { id: b.listId, name: "RLS bypass attempt" } },
              bypass,
            ),
        ],
        [
          "createColumn",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              createColumn,
              b.workspaceId,
              { body: { listId: b.listId, propertyId: b.extraPropId } },
              bypass,
            ),
        ],
        [
          "updateItem",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              updateItem,
              b.workspaceId,
              {
                body: {
                  listId: b.listId,
                  itemEntityId: b.itemEntityId,
                  description: "Tampered",
                },
              },
              bypass,
            ),
        ],
        [
          "createItemComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              createItemComment,
              b.workspaceId,
              {
                body: {
                  listId: b.listId,
                  itemEntityId: b.itemEntityId,
                  body: "Cross-tenant comment",
                },
              },
              bypass,
            ),
        ],
        [
          "reviewItem",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              reviewItem,
              b.workspaceId,
              {
                body: {
                  listId: b.listId,
                  itemEntityId: b.itemEntityId,
                  decision: "approved",
                },
              },
              bypass,
            ),
        ],
        [
          "verifyItemSource",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              verifyItemSource,
              b.workspaceId,
              {
                body: {
                  id: b.itemSourceId,
                  listId: b.listId,
                  itemEntityId: b.itemEntityId,
                  status: "verified",
                },
              },
              bypass,
            ),
        ],
        [
          "readVerification",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readVerification,
              b.workspaceId,
              { params: { runId: b.verifRunId } },
              bypass,
            ),
        ],
        [
          "createClaimReview",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              createClaimReview,
              b.workspaceId,
              {
                body: {
                  runId: b.verifRunId,
                  claimId: b.claimId,
                  event: { kind: "note", note: "Cross-tenant note" },
                },
              },
              bypass,
            ),
        ],
        [
          "createClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              createClaimComment,
              b.workspaceId,
              {
                body: {
                  runId: b.verifRunId,
                  claimId: b.claimId,
                  body: "Cross-tenant claim comment",
                },
              },
              bypass,
            ),
        ],
        [
          "updateClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              updateClaimComment,
              b.workspaceId,
              {
                params: { annotationId: b.claimCommentId },
                body: { change: "body", body: "Hijacked" },
              },
              bypass,
            ),
        ],
        [
          "deleteClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              deleteClaimComment,
              b.workspaceId,
              { params: { annotationId: b.claimCommentId } },
              bypass,
            ),
        ],
        [
          "readDocumentReviewRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readDocumentReviewRun,
              b.workspaceId,
              { params: { runId: b.reviewRunId } },
              bypass,
            ),
        ],
        [
          "decideDocumentReviewFinding",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              decideDocumentReviewFinding,
              b.workspaceId,
              {
                params: { findingId: b.findingId },
                body: { decision: "accepted" },
              },
              bypass,
            ),
        ],
        [
          "exportDocumentReviewRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              exportDocumentReviewRun,
              b.workspaceId,
              { params: { runId: b.reviewRunId }, query: { format: "csv" } },
              bypass,
            ),
        ],
        [
          "readEntityById",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readEntityById,
              b.workspaceId,
              { params: { entityId: b.docId } },
              bypass,
            ),
        ],
        [
          "readVersionById",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              readVersionById,
              b.workspaceId,
              { params: { entityId: b.docId, versionId: b.docVersionId } },
              bypass,
            ),
        ],
        [
          "updateVersionLabel",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              updateVersionLabel,
              b.workspaceId,
              {
                params: { entityId: b.docId, versionId: b.docVersionId },
                body: { label: "Tampered" },
              },
              bypass,
            ),
        ],
        [
          "restoreVersion",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              restoreVersion,
              b.workspaceId,
              { params: { entityId: b.docId, versionId: b.docVersionId } },
              bypass,
            ),
        ],
        [
          "getFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              getFlowRun,
              b.workspaceId,
              { params: { runId: b.flowRunId } },
              bypass,
            ),
        ],
        [
          "cancelFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              cancelFlowRun,
              b.workspaceId,
              { params: { runId: b.flowRunId } },
              bypass,
            ),
        ],
        [
          "reviewFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.ownerA,
              reviewFlowRun,
              b.workspaceId,
              {
                params: { runId: b.flowReviewRunId },
                body: { decision: "approved" },
              },
              bypass,
            ),
        ],
      ];

      for (const [label, run] of directDenied) {
        expectDenied(
          await run(),
          [400, 403, 404, 409],
          `direct RLS cross-tenant: ${label}`,
        );
      }

      // Org-scoped workflow definitions and templates are strictly org-isolated
      expectDenied(
        await invokeOrgHandler(fx.ownerA, getFlowDefinition, {
          params: { flowId: fx.flowDefB },
        }),
        [404],
        "cross-tenant getFlowDefinition",
      );
      expectDenied(
        await invokeOrgHandler(fx.ownerA, updateFlowDefinition, {
          params: { flowId: fx.flowDefB },
          body: {
            name: "Hijacked Flow",
            description: null,
            steps: [
              {
                kind: "review-gate",
                name: "Approve",
                instructions: "Hijacked",
              },
            ],
            trigger: { type: "manual" },
            enabled: true,
            expectedUpdatedAt: FIXED_CREATED_AT.toISOString(),
          },
        }),
        [404],
        "cross-tenant updateFlowDefinition",
      );
      expectDenied(
        await invokeOrgHandler(fx.ownerA, deleteFlowDefinition, {
          params: { flowId: fx.flowDefB },
        }),
        [404],
        "cross-tenant deleteFlowDefinition",
      );
      expectDenied(
        await invokeOrgHandler(fx.ownerA, getTemplate, {
          params: { templateId: fx.templateB },
        }),
        [404],
        "cross-tenant getTemplate",
      );
      expectDenied(
        await invokeOrgHandler(fx.ownerA, updateTemplate, {
          params: { templateId: fx.templateB },
          body: { name: "Hijacked Template" },
        }),
        [404],
        "cross-tenant updateTemplate",
      );
      expectDenied(
        await invokeOrgHandler(fx.ownerA, listTemplateVersions, {
          params: { templateId: fx.templateB },
        }),
        [404],
        "cross-tenant listTemplateVersions",
      );

      // Verify Org B data in DB remained completely untouched
      const [bList] = await testDb
        .select({ name: legalLists.name })
        .from(legalLists)
        .where(eq(legalLists.id, b.listId));
      expect(bList?.name).toBe("Beta-Secret Chronology List");

      const [bFinding] = await testDb
        .select({ decision: documentReviewFindings.decision })
        .from(documentReviewFindings)
        .where(eq(documentReviewFindings.id, b.findingId));
      expect(bFinding?.decision).toBe(DOCUMENT_REVIEW_DECISION.OPEN);

      const [bFlowRun] = await testDb
        .select({ status: flowRuns.status })
        .from(flowRuns)
        .where(eq(flowRuns.id, b.flowRunId));
      expect(bFlowRun?.status).toBe("running");
    });
  });

  describe("2. Intra-org ethical wall & cross-matter ID confusion", () => {
    test("memberA can read assigned matterA_accessible but is blocked from unassigned matterA_restricted", async () => {
      const open = fx.matterA_accessible;
      const secret = fx.matterA_restricted;

      // Positive authorized controls: ownerA genuinely receives restricted matter data
      const ownerRestrictedLists = await invokeWorkspaceHandler(
        fx.ownerA,
        readLists,
        secret.workspaceId,
      );
      expectOk(
        ownerRestrictedLists,
        "authorized control: ownerA restricted readLists",
      );
      expect(JSON.stringify(ownerRestrictedLists)).toContain(
        "Alpha-Restricted",
      );

      const ownerRestrictedLatest = await invokeWorkspaceHandler(
        fx.ownerA,
        readLatestVerifications,
        secret.workspaceId,
        {
          body: {
            documents: [
              { entityId: secret.docId, fileFieldId: secret.fileFieldId },
            ],
          },
        },
      );
      expectOk(
        ownerRestrictedLatest,
        "authorized control: ownerA restricted readLatestVerifications",
      );
      expect(JSON.stringify(ownerRestrictedLatest)).toContain(
        secret.verifRunId,
      );

      // Positive control on assigned matter
      expectOk(
        await invokeWorkspaceHandler(
          fx.memberA,
          readListById,
          open.workspaceId,
          {
            params: { listId: open.listId },
          },
        ),
        "memberA readListById on assigned matter",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.memberA,
          readVerification,
          open.workspaceId,
          { params: { runId: open.verifRunId } },
        ),
        "memberA readVerification on assigned matter",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.memberA,
          readDocumentReviewRun,
          open.workspaceId,
          { params: { runId: open.reviewRunId } },
        ),
        "memberA readDocumentReviewRun on assigned matter",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.memberA,
          readEntityById,
          open.workspaceId,
          {
            params: { entityId: open.docId },
          },
        ),
        "memberA readEntityById on assigned matter",
      );
      expectOk(
        await invokeWorkspaceHandler(fx.memberA, getFlowRun, open.workspaceId, {
          params: { runId: open.flowRunId },
        }),
        "memberA getFlowRun on assigned matter",
      );

      // Route-gate AND direct-RLS denial on unassigned restricted matter
      for (const bypassRouteGate of [false, true]) {
        const mode = bypassRouteGate ? "direct-RLS" : "route-gate";
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            readListById,
            secret.workspaceId,
            { params: { listId: secret.listId } },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: readListById`,
        );
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            readVerification,
            secret.workspaceId,
            { params: { runId: secret.verifRunId } },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: readVerification`,
        );
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            readDocumentReviewRun,
            secret.workspaceId,
            { params: { runId: secret.reviewRunId } },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: readDocumentReviewRun`,
        );
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            decideDocumentReviewFinding,
            secret.workspaceId,
            {
              params: { findingId: secret.findingId },
              body: { decision: "accepted" },
            },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: decideDocumentReviewFinding`,
        );
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            readEntityById,
            secret.workspaceId,
            { params: { entityId: secret.docId } },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: readEntityById`,
        );
        expectDenied(
          await invokeWorkspaceHandler(
            fx.memberA,
            getFlowRun,
            secret.workspaceId,
            { params: { runId: secret.flowRunId } },
            { bypassRouteGate },
          ),
          [404],
          `ethical wall ${mode}: getFlowRun`,
        );
      }

      // Direct-RLS collection queries on restricted matter leak zero rows
      const secretLists = await invokeWorkspaceHandler(
        fx.memberA,
        readLists,
        secret.workspaceId,
        {},
        { bypassRouteGate: true },
      );
      expect(JSON.stringify(secretLists)).not.toContain("Alpha-Restricted");

      const secretLatestVerifs = await invokeWorkspaceHandler(
        fx.memberA,
        readLatestVerifications,
        secret.workspaceId,
        {
          body: {
            documents: [
              { entityId: secret.docId, fileFieldId: secret.fileFieldId },
            ],
          },
        },
        { bypassRouteGate: true },
      );
      expect(JSON.stringify(secretLatestVerifs)).not.toContain(
        secret.verifRunId,
      );
    });

    test("Cross-matter ID confusion is rejected for both memberA and ownerA (who can access both matters)", async () => {
      const m1 = fx.matterA_accessible;
      const m2 = fx.matterA_restricted;

      // Test BOTH memberA (RLS blocks m2) AND ownerA (RLS allows m1 & m2, so
      // handler SQL workspaceId predicates MUST reject every cross-matter pair!)
      const assertCrossMatterDenied = async (actor: Actor) => {
        const who = actor.role;
        const cases: readonly [string, () => Promise<unknown>][] = [
          [
            "(m1, listFromM2) readListById",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readListById,
                m1.workspaceId,
                {
                  params: { listId: m2.listId },
                },
              ),
          ],
          [
            "(m1, listFromM2) updateList",
            async () =>
              await invokeWorkspaceHandler(actor, updateList, m1.workspaceId, {
                body: { id: m2.listId, name: "Cross-matter rename" },
              }),
          ],
          [
            "(m1, listInM1, propFromM2) createColumn",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createColumn,
                m1.workspaceId,
                {
                  body: { listId: m1.listId, propertyId: m2.extraPropId },
                },
              ),
          ],
          [
            "(m1, listInM1, itemInM1, sectionFromM2) updateItem",
            async () =>
              await invokeWorkspaceHandler(actor, updateItem, m1.workspaceId, {
                body: {
                  listId: m1.listId,
                  itemEntityId: m1.itemEntityId,
                  sectionId: m2.sectionId,
                },
              }),
          ],
          [
            "(m1, listInM1, itemFromM2) readItemSources",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readItemSources,
                m1.workspaceId,
                {
                  params: { listId: m1.listId, itemEntityId: m2.itemEntityId },
                },
              ),
          ],
          [
            "(m1, listInM1, itemFromM2) readItemActivity",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readItemActivity,
                m1.workspaceId,
                {
                  params: { listId: m1.listId, itemEntityId: m2.itemEntityId },
                },
              ),
          ],
          [
            "(m1, listInM1, itemInM1, docFromM2) createItemSource",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createItemSource,
                m1.workspaceId,
                {
                  body: {
                    listId: m1.listId,
                    itemEntityId: m1.itemEntityId,
                    sourceEntityId: m2.docId,
                    sourceEntityVersionId: m2.docVersionId,
                    locator: { type: "document" },
                  },
                },
              ),
          ],
          [
            "(m1, listInM1, docFromM2) readSourceDocumentKinds",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readSourceDocumentKinds,
                m1.workspaceId,
                {
                  body: { listId: m1.listId, documentEntityIds: [m2.docId] },
                },
              ),
          ],
          [
            "(m1, verifRunFromM2) readVerification",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readVerification,
                m1.workspaceId,
                {
                  params: { runId: m2.verifRunId },
                },
              ),
          ],
          [
            "(m1, verifRunFromM2, claimFromM2) createClaimReview",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createClaimReview,
                m1.workspaceId,
                {
                  body: {
                    runId: m2.verifRunId,
                    claimId: m2.claimId,
                    event: { kind: "note", note: "Cross-matter claim review" },
                  },
                },
              ),
          ],
          [
            "(m1, verifRunFromM2, claimFromM2) createClaimComment",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createClaimComment,
                m1.workspaceId,
                {
                  body: {
                    runId: m2.verifRunId,
                    claimId: m2.claimId,
                    body: "Cross-matter claim comment",
                  },
                },
              ),
          ],
          [
            "(m1, claimCommentFromM2) updateClaimComment",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                updateClaimComment,
                m1.workspaceId,
                {
                  params: { annotationId: m2.claimCommentId },
                  body: { change: "body", body: "Cross-matter edit" },
                },
              ),
          ],
          [
            "(m1, claimCommentFromM2) deleteClaimComment",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                deleteClaimComment,
                m1.workspaceId,
                {
                  params: { annotationId: m2.claimCommentId },
                },
              ),
          ],
          [
            "(m1, reviewRunFromM2) readDocumentReviewRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readDocumentReviewRun,
                m1.workspaceId,
                { params: { runId: m2.reviewRunId } },
              ),
          ],
          [
            "(m1, findingFromM2) decideDocumentReviewFinding",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                decideDocumentReviewFinding,
                m1.workspaceId,
                {
                  params: { findingId: m2.findingId },
                  body: { decision: "accepted" },
                },
              ),
          ],
          [
            "(m1, docFromM2) readEntityById",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readEntityById,
                m1.workspaceId,
                {
                  params: { entityId: m2.docId },
                },
              ),
          ],
          [
            "(m1, docFromM2, versionFromM2) updateVersionLabel",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                updateVersionLabel,
                m1.workspaceId,
                {
                  params: { entityId: m2.docId, versionId: m2.docVersionId },
                  body: { label: "Cross-matter label" },
                },
              ),
          ],
          [
            "(m1, docFromM2) moveEntity",
            async () =>
              await invokeWorkspaceHandler(actor, moveEntity, m1.workspaceId, {
                body: { entityId: m2.docId, parentId: m1.folderId },
              }),
          ],
          [
            "(m1, docInM1, folderFromM2) moveEntity",
            async () =>
              await invokeWorkspaceHandler(actor, moveEntity, m1.workspaceId, {
                body: { entityId: m1.docId, parentId: m2.folderId },
              }),
          ],
          [
            "(m1, docInM1, versionFromM2) readVersionById",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                readVersionById,
                m1.workspaceId,
                {
                  params: { entityId: m1.docId, versionId: m2.docVersionId },
                },
              ),
          ],
          [
            "(m1, flowRunFromM2) getFlowRun",
            async () =>
              await invokeWorkspaceHandler(actor, getFlowRun, m1.workspaceId, {
                params: { runId: m2.flowRunId },
              }),
          ],
          [
            "(m1, flowRunFromM2) cancelFlowRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                cancelFlowRun,
                m1.workspaceId,
                {
                  params: { runId: m2.flowRunId },
                },
              ),
          ],
          [
            "(m1, flowReviewRunFromM2) reviewFlowRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                reviewFlowRun,
                m1.workspaceId,
                {
                  params: { runId: m2.flowReviewRunId },
                  body: { decision: "approved" },
                },
              ),
          ],
          [
            "(m1, inputDocFromM2) startFlowRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                startFlowRunHandler,
                m1.workspaceId,
                {
                  body: {
                    definitionId: fx.flowDefA,
                    inputEntityIds: [m2.docId],
                  },
                },
              ),
          ],
        ];

        for (const [label, run] of cases) {
          expectDenied(
            await run(),
            [400, 404],
            `cross-matter ID confusion (${who}): ${label}`,
          );
        }

        // Batch read of latest verifications in m1 for m2's doc either returns
        // 404 or an empty run list, and never leaks m2's verification run
        const latestRes = await invokeWorkspaceHandler(
          actor,
          readLatestVerifications,
          m1.workspaceId,
          {
            body: {
              documents: [{ entityId: m2.docId, fileFieldId: m2.fileFieldId }],
            },
          },
        );
        if (isHttpError(latestRes)) {
          expect(latestRes.code).toBe(404);
        } else {
          expect(latestRes).toEqual({ runs: [] });
        }
        expect(JSON.stringify(latestRes)).not.toContain(m2.verifRunId);

        // Verification list in m1 for m2's doc returns empty or 404
        const verifListRes = await invokeWorkspaceHandler(
          actor,
          readVerifications,
          m1.workspaceId,
          { query: { entityId: m2.docId, fileFieldId: m2.fileFieldId } },
        );
        expect(JSON.stringify(verifListRes)).not.toContain(m2.verifRunId);

        // Claim review history in m1 for m2's verification run is denied
        expectDenied(
          await invokeWorkspaceHandler(
            actor,
            listClaimReviews,
            m1.workspaceId,
            {
              query: { runId: m2.verifRunId },
            },
          ),
          [404],
          `cross-matter (${who}) listClaimReviews`,
        );
      };

      await assertCrossMatterDenied(fx.memberA);
      await assertCrossMatterDenied(fx.ownerA);
    });
  });

  describe("3. Archived matter write freeze", () => {
    test("Every write handler on archived matterA_archived is rejected for both assigned memberA and ownerA", async () => {
      const arch = fx.matterA_archived;
      const assertArchivedFrozen = async (actor: Actor) => {
        const who = actor.role;
        const writes: readonly [string, () => Promise<unknown>][] = [
          [
            "updateList",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                updateList,
                arch.workspaceId,
                {
                  body: { id: arch.listId, name: "Archived edit" },
                },
              ),
          ],
          [
            "createColumn",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createColumn,
                arch.workspaceId,
                {
                  body: { listId: arch.listId, propertyId: arch.extraPropId },
                },
              ),
          ],
          [
            "updateItem",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                updateItem,
                arch.workspaceId,
                {
                  body: {
                    listId: arch.listId,
                    itemEntityId: arch.itemEntityId,
                    description: "Archived edit",
                  },
                },
              ),
          ],
          [
            "createItemComment",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createItemComment,
                arch.workspaceId,
                {
                  body: {
                    listId: arch.listId,
                    itemEntityId: arch.itemEntityId,
                    body: "Archived comment",
                  },
                },
              ),
          ],
          [
            "reviewItem",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                reviewItem,
                arch.workspaceId,
                {
                  body: {
                    listId: arch.listId,
                    itemEntityId: arch.itemEntityId,
                    decision: "approved",
                  },
                },
              ),
          ],
          [
            "verifyItemSource",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                verifyItemSource,
                arch.workspaceId,
                {
                  body: {
                    id: arch.itemSourceId,
                    listId: arch.listId,
                    itemEntityId: arch.itemEntityId,
                    status: "verified",
                  },
                },
              ),
          ],
          [
            "createClaimReview",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createClaimReview,
                arch.workspaceId,
                {
                  body: {
                    runId: arch.verifRunId,
                    claimId: arch.claimId,
                    event: { kind: "note", note: "Archived note" },
                  },
                },
              ),
          ],
          [
            "createClaimComment",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                createClaimComment,
                arch.workspaceId,
                {
                  body: {
                    runId: arch.verifRunId,
                    claimId: arch.claimId,
                    body: "Archived claim comment",
                  },
                },
              ),
          ],
          [
            "decideDocumentReviewFinding",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                decideDocumentReviewFinding,
                arch.workspaceId,
                {
                  params: { findingId: arch.findingId },
                  body: { decision: "accepted" },
                },
              ),
          ],
          [
            "updateVersionLabel",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                updateVersionLabel,
                arch.workspaceId,
                {
                  params: {
                    entityId: arch.docId,
                    versionId: arch.docVersionId,
                  },
                  body: { label: "Archived label" },
                },
              ),
          ],
          [
            "restoreVersion",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                restoreVersion,
                arch.workspaceId,
                {
                  params: {
                    entityId: arch.docId,
                    versionId: arch.docVersionId,
                  },
                },
              ),
          ],
          [
            "cancelFlowRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                cancelFlowRun,
                arch.workspaceId,
                {
                  params: { runId: arch.flowRunId },
                },
              ),
          ],
          [
            "reviewFlowRun",
            async () =>
              await invokeWorkspaceHandler(
                actor,
                reviewFlowRun,
                arch.workspaceId,
                {
                  params: { runId: arch.flowReviewRunId },
                  body: { decision: "approved" },
                },
              ),
          ],
        ];

        for (const [label, run] of writes) {
          expectDenied(
            await run(),
            [404],
            `archived write freeze (${who}): ${label}`,
          );
        }
      };

      await assertArchivedFrozen(fx.memberA);
      await assertArchivedFrozen(fx.ownerA);
    });
  });

  describe("4. External collaborator read-only boundary", () => {
    test("collabA can read assigned matterA_accessible, is denied every write (403), and is denied unassigned matterA_restricted (404)", async () => {
      const open = fx.matterA_accessible;
      const secret = fx.matterA_restricted;

      // Positive read controls on assigned matter
      expectOk(
        await invokeWorkspaceHandler(fx.collabA, readLists, open.workspaceId),
        "collabA readLists",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.collabA,
          readListById,
          open.workspaceId,
          {
            params: { listId: open.listId },
          },
        ),
        "collabA readListById",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.collabA,
          readVerification,
          open.workspaceId,
          { params: { runId: open.verifRunId } },
        ),
        "collabA readVerification",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.collabA,
          readDocumentReviewRun,
          open.workspaceId,
          { params: { runId: open.reviewRunId } },
        ),
        "collabA readDocumentReviewRun",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.collabA,
          readEntityById,
          open.workspaceId,
          {
            params: { entityId: open.docId },
          },
        ),
        "collabA readEntityById",
      );
      expectOk(
        await invokeWorkspaceHandler(
          fx.collabA,
          readVersions,
          open.workspaceId,
          {
            params: { entityId: open.docId },
          },
        ),
        "collabA readVersions",
      );
      expectOk(
        await invokeWorkspaceHandler(fx.collabA, getFlowRun, open.workspaceId, {
          params: { runId: open.flowRunId },
        }),
        "collabA getFlowRun",
      );

      // Every write handler on assigned matter is denied with 403
      const writes: readonly [string, () => Promise<unknown>][] = [
        [
          "updateList",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              updateList,
              open.workspaceId,
              {
                body: { id: open.listId, name: "External rename" },
              },
            ),
        ],
        [
          "createColumn",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              createColumn,
              open.workspaceId,
              {
                body: { listId: open.listId, propertyId: open.extraPropId },
              },
            ),
        ],
        [
          "updateItem",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              updateItem,
              open.workspaceId,
              {
                body: {
                  listId: open.listId,
                  itemEntityId: open.itemEntityId,
                  description: "External edit",
                },
              },
            ),
        ],
        [
          "createItemSource",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              createItemSource,
              open.workspaceId,
              {
                body: {
                  listId: open.listId,
                  itemEntityId: open.itemEntityId,
                  sourceEntityId: open.docId,
                  sourceEntityVersionId: open.docVersionId,
                  locator: { type: "document" },
                },
              },
            ),
        ],
        [
          "createItemComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              createItemComment,
              open.workspaceId,
              {
                body: {
                  listId: open.listId,
                  itemEntityId: open.itemEntityId,
                  body: "External comment",
                },
              },
            ),
        ],
        [
          "reviewItem",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              reviewItem,
              open.workspaceId,
              {
                body: {
                  listId: open.listId,
                  itemEntityId: open.itemEntityId,
                  decision: "approved",
                },
              },
            ),
        ],
        [
          "verifyItemSource",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              verifyItemSource,
              open.workspaceId,
              {
                body: {
                  id: open.itemSourceId,
                  listId: open.listId,
                  itemEntityId: open.itemEntityId,
                  status: "verified",
                },
              },
            ),
        ],
        [
          "createClaimReview",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              createClaimReview,
              open.workspaceId,
              {
                body: {
                  runId: open.verifRunId,
                  claimId: open.claimId,
                  event: { kind: "note", note: "External claim review" },
                },
              },
            ),
        ],
        [
          "createClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              createClaimComment,
              open.workspaceId,
              {
                body: {
                  runId: open.verifRunId,
                  claimId: open.claimId,
                  body: "External claim comment",
                },
              },
            ),
        ],
        [
          "updateClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              updateClaimComment,
              open.workspaceId,
              {
                params: { annotationId: open.claimCommentId },
                body: { change: "body", body: "External edit" },
              },
            ),
        ],
        [
          "deleteClaimComment",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              deleteClaimComment,
              open.workspaceId,
              { params: { annotationId: open.claimCommentId } },
            ),
        ],
        [
          "decideDocumentReviewFinding",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              decideDocumentReviewFinding,
              open.workspaceId,
              {
                params: { findingId: open.findingId },
                body: { decision: "accepted" },
              },
            ),
        ],
        [
          "moveEntity",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              moveEntity,
              open.workspaceId,
              {
                body: { entityId: open.docId, parentId: open.folderId },
              },
            ),
        ],
        [
          "updateVersionLabel",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              updateVersionLabel,
              open.workspaceId,
              {
                params: { entityId: open.docId, versionId: open.docVersionId },
                body: { label: "External label" },
              },
            ),
        ],
        [
          "restoreVersion",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              restoreVersion,
              open.workspaceId,
              {
                params: { entityId: open.docId, versionId: open.docVersionId },
              },
            ),
        ],
        [
          "cancelFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              cancelFlowRun,
              open.workspaceId,
              {
                params: { runId: open.flowRunId },
              },
            ),
        ],
        [
          "reviewFlowRun",
          async () =>
            await invokeWorkspaceHandler(
              fx.collabA,
              reviewFlowRun,
              open.workspaceId,
              {
                params: { runId: open.flowReviewRunId },
                body: { decision: "approved" },
              },
            ),
        ],
        [
          "updateFlowDefinition",
          async () =>
            await invokeOrgHandler(fx.collabA, updateFlowDefinition, {
              params: { flowId: fx.flowDefA },
              body: { name: "External flow edit" },
            }),
        ],
        [
          "deleteFlowDefinition",
          async () =>
            await invokeOrgHandler(fx.collabA, deleteFlowDefinition, {
              params: { flowId: fx.flowDefA },
            }),
        ],
        [
          "updateTemplate",
          async () =>
            await invokeOrgHandler(fx.collabA, updateTemplate, {
              params: { templateId: fx.templateA },
              body: { name: "External template edit" },
            }),
        ],
      ];

      for (const [label, run] of writes) {
        expectDenied(await run(), [403], `external read-only: ${label}`);
      }

      // Unassigned restricted matter is denied even for reads
      expectDenied(
        await invokeWorkspaceHandler(
          fx.collabA,
          readListById,
          secret.workspaceId,
          { params: { listId: secret.listId } },
        ),
        [404],
        "external unassigned readListById",
      );
      expectDenied(
        await invokeWorkspaceHandler(
          fx.collabA,
          readDocumentReviewRun,
          secret.workspaceId,
          { params: { runId: secret.reviewRunId } },
        ),
        [404],
        "external unassigned readDocumentReviewRun",
      );
    });
  });

  describe("5. Live membership revocation", () => {
    test("Removing memberA's workspace_members row immediately revokes both route-gate and membership-scoped RLS access", async () => {
      const open = fx.matterA_accessible;

      // Baseline: memberA can read before revocation
      expectOk(
        await invokeWorkspaceHandler(
          fx.memberA,
          readListById,
          open.workspaceId,
          {
            params: { listId: open.listId },
          },
        ),
        "pre-revocation readListById",
      );

      await testDb
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, open.workspaceId),
            eq(workspaceMembers.userId, fx.memberA.userId),
          ),
        );

      try {
        for (const bypassRouteGate of [false, true]) {
          const mode = bypassRouteGate ? "direct-RLS" : "route-gate";
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              readListById,
              open.workspaceId,
              { params: { listId: open.listId } },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: readListById`,
          );
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              readVerification,
              open.workspaceId,
              { params: { runId: open.verifRunId } },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: readVerification`,
          );
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              readDocumentReviewRun,
              open.workspaceId,
              { params: { runId: open.reviewRunId } },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: readDocumentReviewRun`,
          );
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              readEntityById,
              open.workspaceId,
              { params: { entityId: open.docId } },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: readEntityById`,
          );
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              getFlowRun,
              open.workspaceId,
              { params: { runId: open.flowRunId } },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: getFlowRun`,
          );
          expectDenied(
            await invokeWorkspaceHandler(
              fx.memberA,
              decideDocumentReviewFinding,
              open.workspaceId,
              {
                params: { findingId: open.findingId },
                body: { decision: "accepted" },
              },
              { bypassRouteGate },
            ),
            [404],
            `post-revocation ${mode}: decideDocumentReviewFinding`,
          );
        }
      } finally {
        await testDb.insert(workspaceMembers).values({
          workspaceId: open.workspaceId,
          userId: fx.memberA.userId,
          createdAt: FIXED_CREATED_AT,
        });
      }
    });
  });
});
