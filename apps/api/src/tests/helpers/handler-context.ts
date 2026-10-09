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
 * Assert that this path must not record audit events. The recorder panics, but
 * inside `safeDb(tx => ...)` the panic surfaces as the transaction's database
 * error, so a NO_AUDIT test must not treat a generic database error as success.
 */
export const NO_AUDIT = { type: "no_audit" } as const;
/** Assert that this path must not access this database collaborator. */
export const NO_DB = { type: "no_db" } as const;

/** Shared safe-handler context factory. Identity defaults are overridable;
 * audit and database collaborators must be supplied or explicitly forbidden.
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
  Omit<
    BaseTestHandlerContext,
    "user" | "safeDb" | "scopedDb" | "recordAuditEvent"
  >
> & {
  audit: AuditRecorder | typeof NO_AUDIT;
  recordAuditEvent?: never;
  user?: Partial<BaseTestHandlerContext["user"]>;
  safeDb: SafeDb | SafeDb<TestDatabaseTransaction> | typeof NO_DB;
  scopedDb: ScopedDb | ScopedDb<TestDatabaseTransaction> | typeof NO_DB;
} & Record<string, unknown>;

const DEFAULT_WORKSPACE_ID = toSafeId<"workspace">("workspace_test");
const DEFAULT_ORGANIZATION_ID = toSafeId<"organization">("org_test");
const DEFAULT_USER_ID = toSafeId<"user">("user_test");

// Audited paths must choose a recorder explicitly, just as database paths
// must supply their database collaborator.
const unconfiguredAuditRecorder: AuditRecorder = () =>
  panic("createTestHandlerContext: NO_AUDIT path recorded an audit event");

// A handler that reaches for the database without the test providing one is a
// test bug, not an empty result: fail loudly instead of silently returning
// nothing.
const unconfiguredDb = (): never =>
  panic("createTestHandlerContext: NO_DB path accessed the database");

const createBaseContext = (): Omit<
  BaseTestHandlerContext,
  "safeDb" | "scopedDb" | "recordAuditEvent" | "createAuditRecorder"
> => ({
  workspaceId: DEFAULT_WORKSPACE_ID,
  memberRole: sessionMemberRole("owner"),
  session: { activeOrganizationId: DEFAULT_ORGANIZATION_ID },
  user: { id: DEFAULT_USER_ID, email: "standard@example.test" },
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
  overrides: TestHandlerContextOverrides,
): TContext => {
  const base = createBaseContext();
  const { audit, safeDb, scopedDb, createAuditRecorder, ...fields } = overrides;
  const recordAuditEvent =
    typeof audit === "function" ? audit : unconfiguredAuditRecorder;
  return asTestRaw<TContext>({
    ...base,
    ...fields,
    // Only the sentinel is replaced; any supplied double passes through as is.
    safeDb: safeDb === NO_DB ? unconfiguredDb : safeDb,
    scopedDb: scopedDb === NO_DB ? unconfiguredDb : scopedDb,
    recordAuditEvent,
    createAuditRecorder: createAuditRecorder ?? (() => recordAuditEvent),
    // Merge identity details and replace authority as one value.
    memberRole: overrides.memberRole ?? base.memberRole,
    session: { ...base.session, ...overrides.session },
    user: { ...base.user, ...overrides.user },
  });
};
