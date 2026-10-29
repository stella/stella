import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { OrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import type { AuditExecutionContext, AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { SseStreamBinding } from "@/api/lib/sse";

/** Builds a recorder whose events default to another matter (or none). */
export type AuditRecorderFactory = (opts?: {
  execution?: AuditExecutionContext;
  workspaceId?: SafeId<"workspace"> | null;
}) => AuditRecorder;

/**
 * A member of the active organization, with the databases and lookups every
 * org handler uses. A browser session proves one for a REST request; an MCP
 * session proves one for a capability call. Handlers are written against
 * this type, so both transports hand them the same thing.
 */
export type MemberCaller = Readonly<OrgSettingsForAuth> & {
  readonly user: { readonly id: SafeId<"user">; readonly email: string };
  readonly session: {
    /** The browser session, or `null` for a credential that has none (MCP). */
    readonly id: string | null;
    readonly activeOrganizationId: SafeId<"organization">;
    /**
     * What keeps an event stream this caller opens authorized when no
     * browser session backs it (an app's access token).
     */
    readonly stream?: SseStreamBinding;
    /**
     * The OAuth scopes of an app's access token, for a handler whose consent
     * depends on the request rather than its route (an upload's purpose).
     * Absent for a browser session, and for MCP, which checks that consent
     * before dispatch.
     */
    readonly grantedScopes?: readonly string[];
  };
  readonly featureAccessSnapshot?: FeatureAccessSnapshot;
  readonly scopedDb: ScopedDb;
  readonly safeDb: SafeDb;
  /** Resolve non-deleting workspace IDs only when an operation spans matters. */
  readonly getActiveWorkspaceIds: () => Promise<SafeId<"workspace">[]>;
  /** Resolve every accessible workspace only when status metadata is needed. */
  readonly getAccessibleWorkspaces: () => Promise<AccessibleWorkspace[]>;
  /** Resolve one workspace by primary key without expanding the access set. */
  readonly getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  /** Preserve only a workspace whose access this request already proved. */
  readonly pinServerValidatedWorkspaceId: (
    workspaceId: SafeId<"workspace">,
  ) => boolean;
  /** The member's role, attenuated by the credential's own grants. */
  readonly memberRole: AuthorizedMemberRole;
  /**
   * Records an audit row in the supplied transaction. Identity fields
   * (org/user/IP/UA) are bound from the request; workspaceId defaults to
   * the matter a workspace route names, or null, and each event can still
   * override it.
   */
  readonly recordAuditEvent: AuditRecorder;
  /**
   * Builds a recorder with an overridden default workspaceId, for helpers
   * that don't receive the handler ctx (cross-workspace operations, shared
   * copy/move utilities).
   */
  readonly createAuditRecorder: AuditRecorderFactory;
};

/**
 * A member signed in through a browser session, which always has an id, and
 * whose member lookup always decided feature access.
 */
export type SessionMemberCaller = MemberCaller & {
  readonly session: {
    readonly id: string;
    /** The MCP consent a web link opened this session from, if one did. */
    readonly originConsentId: string | null;
  };
  readonly featureAccessSnapshot: FeatureAccessSnapshot;
};

/** The matter a workspace route names, proven for its member. */
export type WorkspaceCaller = {
  readonly workspaceId: SafeId<"workspace">;
  readonly recordAuditEvent: AuditRecorder;
  readonly createAuditRecorder: AuditRecorderFactory;
};
