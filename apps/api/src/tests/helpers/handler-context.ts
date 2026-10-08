import { panic } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  ORG_AI_CONFIG_STATUS,
  type OrgAIConfigStatus,
} from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabaseTransaction } from "@/api/tests/security/test-utils";

/**
 * Shared safe-handler context factory for API handler tests.
 *
 * Roughly forty handler test files hand-roll the object a `createSafeHandler`
 * / `createSafeRootHandler` handler receives, repeating the same
 * `workspaceId` / `memberRole` / `session` / `user` / `recordAuditEvent`
 * boilerplate around whatever `body`, `query`, `params`, `safeDb`, and
 * `scopedDb` the handler under test actually reads. This factory centralises
 * that boilerplate so those files can migrate mechanically: replace the
 * `asTestRaw<Ctx>({ ...identity boilerplate..., body })` literal with
 * `createTestHandlerContext<Ctx>({ body, safeDb, scopedDb })`.
 *
 * The defaults mirror the most common hand-rolled shape (an owner acting in a
 * single workspace) and additionally supply the richer accessor fields
 * (`getActiveWorkspaceIds`, `getWorkspaceAccess`, `createAuditRecorder`, ...)
 * that the DB-backed integration contexts need, so one factory covers both the
 * pure-mock and the PGlite-backed styles. Every field is overridable, and the
 * session and user identity objects deep-merge; member authority is replaced
 * as one value.
 */

/** The identity/capability fields the factory owns defaults for. */
export type BaseTestHandlerContext = {
  workspaceId: SafeId<"workspace">;
  memberRole: AuthorizedMemberRole;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user">; email: string };
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  recordAuditEvent: AuditRecorder;
  createAuditRecorder: (opts?: {
    workspaceId?: SafeId<"workspace"> | null;
  }) => AuditRecorder;
  getActiveWorkspaceIds: () => Promise<SafeId<"workspace">[]>;
  getAccessibleWorkspaces: () => Promise<AccessibleWorkspace[]>;
  getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  pinServerValidatedWorkspaceId: (workspaceId: SafeId<"workspace">) => boolean;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
  managedAIResidency: ManagedAIResidency;
  request: Request;
  route: string;
};

/**
 * Overrides accepted by {@link createTestHandlerContext}. The base identity
 * fields are partially overridable and any extra per-handler fields (`body`,
 * `query`, `params`, ...) pass straight through onto the returned context.
 */
export type TestHandlerContextOverrides = Partial<
  Omit<BaseTestHandlerContext, "user" | "safeDb" | "scopedDb">
> & {
  user?: Partial<BaseTestHandlerContext["user"]>;
  safeDb?: SafeDb | SafeDb<TestDatabaseTransaction>;
  scopedDb?: ScopedDb | ScopedDb<TestDatabaseTransaction>;
} & Record<string, unknown>;

const DEFAULT_WORKSPACE_ID = toSafeId<"workspace">("workspace_test");
const DEFAULT_ORGANIZATION_ID = toSafeId<"organization">("org_test");
const DEFAULT_USER_ID = toSafeId<"user">("user_test");

// Audited paths must choose a recorder explicitly, just as database paths
// must supply their database collaborator.
const unconfiguredAuditRecorder: AuditRecorder = () =>
  panic(
    "createTestHandlerContext: no audit recorder provided; configure recordAuditEvent/createAuditRecorder in overrides",
  );

// A handler that reaches for the database without the test providing one is a
// test bug, not an empty result: fail loudly instead of silently returning
// nothing.
const unconfiguredDb = (): never =>
  panic(
    "createTestHandlerContext: no safeDb/scopedDb provided; pass one in overrides",
  );

const createBaseContext = (): BaseTestHandlerContext => ({
  workspaceId: DEFAULT_WORKSPACE_ID,
  memberRole: sessionMemberRole("owner"),
  session: { activeOrganizationId: DEFAULT_ORGANIZATION_ID },
  user: { id: DEFAULT_USER_ID, email: "standard@example.test" },
  safeDb: unconfiguredDb,
  scopedDb: unconfiguredDb,
  recordAuditEvent: unconfiguredAuditRecorder,
  createAuditRecorder: () => unconfiguredAuditRecorder,
  getActiveWorkspaceIds: async () =>
    await Promise.resolve([DEFAULT_WORKSPACE_ID]),
  getAccessibleWorkspaces: async () =>
    await Promise.resolve([{ id: DEFAULT_WORKSPACE_ID, status: "active" }]),
  getWorkspaceAccess: async (workspaceId) =>
    await Promise.resolve(
      workspaceId === DEFAULT_WORKSPACE_ID
        ? { id: workspaceId, status: "active" }
        : null,
    ),
  // Mirrors the accessible set encoded above (getWorkspaceAccess /
  // getActiveWorkspaceIds): only the default workspace is pinnable out of
  // the box, matching production's rejection of IDs outside the validated
  // set. Callers exercising cross-workspace/pinning rejection paths must
  // override this alongside the accessible-workspace fields.
  pinServerValidatedWorkspaceId: (workspaceId) =>
    workspaceId === DEFAULT_WORKSPACE_ID,
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  managedAIResidency: "eu",
  request: new Request("https://example.test/handler-context"),
  route: "/tests/handler-context",
});

/**
 * Build a safe-handler test context. `TContext` is the handler's own context
 * type (`Parameters<typeof handler.handler>[0]`); pass it so the result slots
 * into the handler call without a further cast.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter IS the API: callers pin the handler's own context type per call
export const createTestHandlerContext = <TContext = BaseTestHandlerContext>(
  overrides: TestHandlerContextOverrides = {},
): TContext => {
  const base = createBaseContext();
  // One configured recorder serves both entry points: workspace handlers
  // rebind `recordAuditEvent` from `createAuditRecorder`, so configuring only
  // one of them must still reach the test's recorder. Only a context with
  // neither stays unconfigured.
  const { recordAuditEvent, createAuditRecorder } = overrides;
  return asTestRaw<TContext>({
    ...base,
    ...overrides,
    recordAuditEvent:
      recordAuditEvent ??
      (createAuditRecorder
        ? createAuditRecorder({ workspaceId: null })
        : base.recordAuditEvent),
    createAuditRecorder:
      createAuditRecorder ??
      (recordAuditEvent ? () => recordAuditEvent : base.createAuditRecorder),
    // Merge identity details and replace authority as one value.
    memberRole: overrides.memberRole ?? base.memberRole,
    session: { ...base.session, ...overrides.session },
    user: { ...base.user, ...overrides.user },
  });
};
