import { panic, Result, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import type { PermissionInput } from "@stll/permissions";

import type { Transaction } from "@/api/db/root";
import { AI_MEMORY_SCOPE_FREE_KINDS, aiMemories } from "@/api/db/schema";
import type { AiMemoryKind, AiMemoryScope } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { createMemoryDedupIdentity } from "@/api/lib/memory/memory-dedup";
import type { MemoryDedupScope } from "@/api/lib/memory/memory-dedup";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

/**
 * Shared authorization for explicit memory writes, used by every transport
 * that reaches `persistExplicitMemory` on behalf of a member (REST, chat).
 * `resolveMemoryWriteScope` checks the member's permission for the requested
 * scope, the target matter of a matter-scoped memory, and the kind/scope
 * rule. It mints the only value `persistExplicitMemory` accepts as the row's
 * owner, so an unchecked scope cannot reach the insert. Callers run it per
 * write, not once per session or tool registration.
 */
export type MemoryWriteScopeRequest =
  | { scope: "organization"; kind: AiMemoryKind }
  | { scope: "user"; kind: AiMemoryKind }
  | {
      scope: "workspace";
      kind: AiMemoryKind;
      workspaceId: SafeId<"workspace">;
    };

const MEMORY_WRITE_PERMISSIONS = {
  organization: { firmMemory: ["create"] },
  user: { chat: ["create"] },
  workspace: { chat: ["create"], workspace: ["update"] },
} as const satisfies Record<AiMemoryScope, PermissionInput>;

// Mirrors the DB CHECK `ai_memories_kind_scope_check`: matter-derived kinds
// may only live at workspace scope, so a fact about one matter can never be
// saved as user or firm (cross-matter) memory.
const SCOPE_FREE_KINDS: ReadonlySet<AiMemoryKind> = new Set(
  AI_MEMORY_SCOPE_FREE_KINDS,
);

export type MemoryWriteRefusalCode =
  | "forbidden"
  | "workspace-not-found"
  | "workspace-not-active"
  | "kind-requires-workspace";

export class MemoryWriteRefusedError extends TaggedError(
  "MemoryWriteRefusedError",
)<{
  code: MemoryWriteRefusalCode;
  kind: AiMemoryKind;
  message: string;
}> {}

type MemoryWriteTarget = MemoryDedupScope & {
  createdBy: SafeId<"user">;
  kind: AiMemoryKind;
  organizationId: SafeId<"organization">;
};

class MemoryWriteScopeProof {
  readonly #target: MemoryWriteTarget;
  constructor(target: MemoryWriteTarget) {
    this.#target = target;
  }
  get target(): MemoryWriteTarget {
    return this.#target;
  }
}

/** Every check passed; the row's owner, kind and author come from here. */
export type AuthorizedMemoryWriteScope = MemoryWriteScopeProof;

type ResolveMemoryWriteScopeOptions = {
  /**
   * The matters the member can access, with their current status, resolved
   * server-side for this request. Read only for a workspace-scoped request;
   * the stored id is taken from here, never from the request.
   */
  accessibleWorkspaces: readonly AccessibleWorkspace[];
  authority: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  request: MemoryWriteScopeRequest;
  userId: SafeId<"user">;
};

const resolveMemoryOwner = ({
  accessibleWorkspaces,
  request,
  userId,
}: Pick<
  ResolveMemoryWriteScopeOptions,
  "accessibleWorkspaces" | "request" | "userId"
>): Result<MemoryDedupScope, MemoryWriteRefusalCode> => {
  switch (request.scope) {
    case "organization": {
      return Result.ok({
        scope: "organization",
        userId: null,
        workspaceId: null,
      });
    }
    case "user": {
      return Result.ok({ scope: "user", userId, workspaceId: null });
    }
    case "workspace": {
      const workspace = accessibleWorkspaces.find(
        ({ id }) => id === request.workspaceId,
      );
      if (workspace === undefined) {
        return Result.err("workspace-not-found");
      }
      if (workspace.status !== "active") {
        return Result.err("workspace-not-active");
      }
      return Result.ok({
        scope: "workspace",
        userId: null,
        workspaceId: workspace.id,
      });
    }
    default: {
      request satisfies never;
      return panic(`Unhandled memory scope: ${String(request)}`);
    }
  }
};

const MEMORY_WRITE_REFUSAL_MESSAGES = {
  forbidden: "Forbidden",
  "workspace-not-found": "Workspace not found",
  "workspace-not-active": "Workspace is archived or unavailable",
  "kind-requires-workspace": "Kind is only allowed on workspace-scoped memory",
} as const satisfies Record<MemoryWriteRefusalCode, string>;

const refuse = (code: MemoryWriteRefusalCode, kind: AiMemoryKind) =>
  Result.err(
    new MemoryWriteRefusedError({
      code,
      kind,
      message: MEMORY_WRITE_REFUSAL_MESSAGES[code],
    }),
  );

/**
 * Checks run in the order the REST create route has always reported them:
 * the target matter, then the member's permission, then the kind/scope rule.
 */
export const resolveMemoryWriteScope = ({
  accessibleWorkspaces,
  authority,
  organizationId,
  request,
  userId,
}: ResolveMemoryWriteScopeOptions): Result<
  AuthorizedMemoryWriteScope,
  MemoryWriteRefusedError
> => {
  const owner = resolveMemoryOwner({ accessibleWorkspaces, request, userId });
  if (Result.isError(owner)) {
    return refuse(owner.error, request.kind);
  }
  if (
    !hasMemberPermission(authority, MEMORY_WRITE_PERMISSIONS[request.scope])
  ) {
    return refuse("forbidden", request.kind);
  }
  if (
    owner.value.scope !== "workspace" &&
    !SCOPE_FREE_KINDS.has(request.kind)
  ) {
    return refuse("kind-requires-workspace", request.kind);
  }
  return Result.ok(
    new MemoryWriteScopeProof({
      ...owner.value,
      createdBy: userId,
      kind: request.kind,
      organizationId,
    }),
  );
};

// The REST route has always answered an inaccessible and an archived matter
// alike, so archived matters are not distinguishable from absent ones there.
const MEMORY_WRITE_REFUSAL_HTTP = {
  forbidden: { status: 403, message: "Forbidden" },
  "workspace-not-found": { status: 404, message: "Workspace not found" },
  "workspace-not-active": { status: 404, message: "Workspace not found" },
  "kind-requires-workspace": { status: 400, message: null },
} as const satisfies Record<
  MemoryWriteRefusalCode,
  { status: number; message: string | null }
>;

export const memoryWriteRefusalHandlerError = ({
  code,
  kind,
}: MemoryWriteRefusedError): HandlerError => {
  const { status, message } = MEMORY_WRITE_REFUSAL_HTTP[code];
  return new HandlerError({
    status,
    message:
      message ?? `Kind "${kind}" is only allowed on workspace-scoped memory`,
  });
};

const memoryWriteRefusalChatMessage = ({
  code,
  kind,
}: MemoryWriteRefusedError): string => {
  switch (code) {
    case "forbidden": {
      return "You do not have permission to manage shared matter memory.";
    }
    case "workspace-not-found": {
      return "The chat's matter is not accessible.";
    }
    case "workspace-not-active": {
      return "The chat's matter is archived or unavailable, so its memory cannot change.";
    }
    case "kind-requires-workspace": {
      return `Kind "${kind}" is only allowed on matter-scoped memory.`;
    }
    default: {
      code satisfies never;
      return panic(`Unhandled memory write refusal: ${String(code)}`);
    }
  }
};

export const memoryWriteRefusalChatToolError = (
  error: MemoryWriteRefusedError,
): ChatToolError =>
  new ChatToolError({
    kind: "invalid-input",
    message: memoryWriteRefusalChatMessage(error),
    cause: error,
  });

type ExplicitMemoryContent = Pick<
  typeof aiMemories.$inferInsert,
  "content" | "language" | "pinned" | "source"
> & {
  sourceDataWorkspaceIds: readonly SafeId<"workspace">[];
};

type PersistExplicitMemoryOptions = {
  memory: ExplicitMemoryContent;
  metadataOnConflict?:
    | {
        language?: string | null | undefined;
        pinned?: boolean | undefined;
      }
    | undefined;
  recordAuditEvent: AuditRecorder;
  scope: AuthorizedMemoryWriteScope;
  tx: Transaction;
};

export type PersistExplicitMemoryResult = {
  id: SafeId<"aiMemory">;
  type: "created" | "existing" | "reactivated";
};

/**
 * Insert an explicit user/tool memory under the database's exact-dedup
 * constraint. Active duplicates are idempotent. An explicit duplicate of an
 * inactive row reactivates it; background extraction deliberately does not use
 * this helper, so dismissed suggestions remain tombstones.
 */
export const persistExplicitMemory = async ({
  memory,
  metadataOnConflict,
  recordAuditEvent,
  scope: { target },
  tx,
}: PersistExplicitMemoryOptions): Promise<PersistExplicitMemoryResult> => {
  const identity = createMemoryDedupIdentity({
    ...target,
    content: memory.content,
    sourceDataWorkspaceIds: memory.sourceDataWorkspaceIds,
  });
  const values = {
    organizationId: target.organizationId,
    scope: target.scope,
    userId: target.userId,
    workspaceId: target.workspaceId,
    kind: target.kind,
    content: memory.content,
    dedupKey: identity.dedupKey,
    language: memory.language,
    sourceDataWorkspaceIds: identity.sourceDataWorkspaceIds,
    source: memory.source,
    status: "active",
    pinned: memory.pinned,
    createdBy: target.createdBy,
  } satisfies typeof aiMemories.$inferInsert;
  const [inserted] = await tx
    .insert(aiMemories)
    .values(values)
    .onConflictDoNothing({
      target: [aiMemories.organizationId, aiMemories.dedupKey],
    })
    .returning({ id: aiMemories.id });

  if (inserted) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
      resourceId: inserted.id,
      workspaceId: values.workspaceId ?? null,
      changes: {
        created: {
          old: null,
          new: { scope: values.scope, kind: values.kind },
        },
      },
    });
    return { id: inserted.id, type: "created" };
  }

  const [existing] = await tx
    .select({
      id: aiMemories.id,
      language: aiMemories.language,
      pinned: aiMemories.pinned,
      status: aiMemories.status,
    })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.organizationId, values.organizationId),
        eq(aiMemories.dedupKey, values.dedupKey),
      ),
    )
    .limit(1)
    .for("update");
  if (!existing) {
    panic("Memory dedup conflict row disappeared");
  }
  const nextLanguage =
    metadataOnConflict?.language !== undefined &&
    metadataOnConflict.language !== existing.language
      ? metadataOnConflict.language
      : undefined;
  const nextPinned =
    metadataOnConflict?.pinned !== undefined &&
    metadataOnConflict.pinned !== existing.pinned
      ? metadataOnConflict.pinned
      : undefined;
  const metadataSet: { language?: string | null; pinned?: boolean } = {
    ...(nextLanguage !== undefined ? { language: nextLanguage } : {}),
    ...(nextPinned !== undefined ? { pinned: nextPinned } : {}),
  };
  const metadataChanges = {
    ...(metadataSet.language !== undefined
      ? {
          language: {
            old: existing.language,
            new: metadataSet.language,
          },
        }
      : {}),
    ...(metadataSet.pinned !== undefined
      ? { pinned: { old: existing.pinned, new: metadataSet.pinned } }
      : {}),
  };

  if (existing.status === "active") {
    if (Object.keys(metadataSet).length === 0) {
      return { id: existing.id, type: "existing" };
    }
    await tx
      .update(aiMemories)
      .set(metadataSet)
      .where(eq(aiMemories.id, existing.id));
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
      resourceId: existing.id,
      workspaceId: values.workspaceId ?? null,
      changes: metadataChanges,
    });
    return { id: existing.id, type: "existing" };
  }

  await tx
    .update(aiMemories)
    .set({
      status: "active",
      archivedAt: null,
      lastUsedAt: new Date(),
      ...metadataSet,
    })
    .where(eq(aiMemories.id, existing.id));
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
    resourceId: existing.id,
    workspaceId: values.workspaceId ?? null,
    changes: {
      status: { old: existing.status, new: "active" },
      ...metadataChanges,
    },
  });
  return { id: existing.id, type: "reactivated" };
};
