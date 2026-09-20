/**
 * Which accessible matter owns a document entity, and whether this caller may
 * write to it. Shared by the document tools and the compare tool so both
 * reach a document through one gate rather than two that can drift.
 */

import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { includes } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type { InternalToolErrorResult } from "@/api/mcp/tool-types";
import {
  ensureActiveWorkspace,
  errorResult,
  notFoundResult,
} from "@/api/mcp/tool-utils";

/** Kinds surfaced by list_documents; tasks/messages/links are other tools. */
export const LISTABLE_ENTITY_KINDS = ["document", "folder"] as const;

/** Entity kind the document tools operate on (same set list_documents surfaces). */
type DocumentEntityKind = (typeof LISTABLE_ENTITY_KINDS)[number];

const isDocumentEntityKind = (kind: string): kind is DocumentEntityKind =>
  includes(LISTABLE_ENTITY_KINDS, kind);

/**
 * Outcome of resolving an entity for a document tool. `wrong-kind` is kept
 * distinct from `not-found` so callers can tell a caller that their own
 * (accessible) entity is a task/message/link rather than silently 404ing.
 */
export type ResolvedDocumentEntity =
  | {
      status: "ok";
      workspaceId: SafeId<"workspace">;
      kind: DocumentEntityKind;
      name: string;
    }
  | { status: "not-found" }
  | { status: "wrong-kind" };

/**
 * Resolve the accessible workspace that owns an entity. The document tools
 * (read/update/delete/set_field_value) only operate on the kinds list_documents
 * surfaces (document, folder); other kinds an entity ID happens to name are
 * rejected as `wrong-kind` rather than acted on.
 */
export const resolveEntityWorkspace = async ({
  context,
  entityId,
}: {
  context: McpRequestContext;
  entityId: SafeId<"entity">;
}): Promise<ResolvedDocumentEntity> => {
  if (context.accessibleWorkspaceIds.length === 0) {
    return { status: "not-found" };
  }
  const entity = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: { eq: entityId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { workspaceId: true, kind: true, name: true },
    }),
  );
  if (!entity) {
    return { status: "not-found" };
  }
  if (!isDocumentEntityKind(entity.kind)) {
    return { status: "wrong-kind" };
  }
  return {
    status: "ok",
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    name: entity.name,
  };
};

/**
 * Map a non-`ok` entity resolution to a tool error. `wrong-kind` names the
 * caller's own accessible entity's shape (no cross-tenant disclosure); a
 * miss stays a generic not-found so a probed ID reveals nothing.
 */
export const documentEntityNotAvailable = (
  resolution: { status: "not-found" } | { status: "wrong-kind" },
) =>
  resolution.status === "wrong-kind"
    ? errorResult("Not a document or folder entity")
    : notFoundResult("Document not found or not accessible");

export type DocumentWriteTarget =
  | {
      status: "ok";
      entityId: SafeId<"entity">;
      workspaceId: SafeId<"workspace">;
    }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * The document a write tool is about to act on: authority to update entities,
 * an accessible owning matter, and that matter still active. Documents in an
 * archived matter are read-only, matching the HTTP entity routes behind the
 * active-only workspace group.
 */
export const resolveDocumentWriteTarget = async ({
  context,
  entityId: rawEntityId,
}: {
  context: McpRequestContext;
  entityId: string;
}): Promise<DocumentWriteTarget> => {
  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return { status: "error", response: errorResult("Forbidden") };
  }

  const entityId = brandPersistedEntityId(rawEntityId);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return {
      status: "error",
      response: documentEntityNotAvailable(owner),
    };
  }
  const active = ensureActiveWorkspace({
    context,
    workspaceId: owner.workspaceId,
  });
  if (typeof active !== "string") {
    return { status: "error", response: active };
  }
  return { entityId, status: "ok", workspaceId: owner.workspaceId };
};
