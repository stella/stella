import { panic } from "better-result";

import type { roles } from "@stll/permissions";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
 * three nested identity objects deep-merge so a caller can change just
 * `session.activeOrganizationId` or just `memberRole.role` without restating
 * the rest.
 */

/** The identity/capability fields the factory owns defaults for. */
export type BaseTestHandlerContext = {
  workspaceId: SafeId<"workspace">;
  memberRole: { role: keyof typeof roles };
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
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
  promptCachingEnabled: boolean;
  request: Request;
  route: string;
};

/**
 * Overrides accepted by {@link createTestHandlerContext}. The base identity
 * fields are partially overridable and any extra per-handler fields (`body`,
 * `query`, `params`, ...) pass straight through onto the returned context.
 */
export type TestHandlerContextOverrides = Partial<BaseTestHandlerContext> &
  Record<string, unknown>;

const DEFAULT_WORKSPACE_ID = toSafeId<"workspace">("workspace_test");
const DEFAULT_ORGANIZATION_ID = toSafeId<"organization">("org_test");
const DEFAULT_USER_ID = toSafeId<"user">("user_test");

const noopAuditRecorder: AuditRecorder = async () => await Promise.resolve();

// A handler that reaches for the database without the test providing one is a
// test bug, not an empty result: fail loudly instead of silently returning
// nothing.
const unconfiguredDb = (): never =>
  panic(
    "createTestHandlerContext: no safeDb/scopedDb provided; pass one in overrides",
  );

const createBaseContext = (): BaseTestHandlerContext => ({
  workspaceId: DEFAULT_WORKSPACE_ID,
  memberRole: { role: "owner" },
  session: { activeOrganizationId: DEFAULT_ORGANIZATION_ID },
  user: { id: DEFAULT_USER_ID },
  safeDb: unconfiguredDb,
  scopedDb: unconfiguredDb,
  recordAuditEvent: noopAuditRecorder,
  createAuditRecorder: () => noopAuditRecorder,
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
  promptCachingEnabled: false,
  request: new Request("https://example.test/handler-context"),
  route: "/tests/handler-context",
});

/**
 * Build a safe-handler test context. `TContext` is the handler's own context
 * type (`Parameters<typeof handler.handler>[0]`); pass it so the result slots
 * into the handler call without a further cast.
 */
// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter IS the API: callers pin the handler's own context type per call
export const createTestHandlerContext = <TContext = BaseTestHandlerContext>(
  overrides: TestHandlerContextOverrides = {},
): TContext => {
  const base = createBaseContext();
  return asTestRaw<TContext>({
    ...base,
    ...overrides,
    // Deep-merge the nested identity objects so a caller can override a single
    // field (just the org id, just the role) without restating the siblings.
    memberRole: { ...base.memberRole, ...overrides.memberRole },
    session: { ...base.session, ...overrides.session },
    user: { ...base.user, ...overrides.user },
  });
};
