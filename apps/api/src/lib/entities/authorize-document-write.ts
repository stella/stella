import { panic, Result, TaggedError } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ChatToolErrorKind } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

/**
 * Shared authorization for writing document content, used by every transport
 * that reaches `createEntityFromBuffer` or `createEntityVersionFromBuffer` on
 * behalf of a member (REST, MCP, chat).
 *
 * Two steps, each minting a value only this module can construct:
 *
 * 1. `authorizeDocumentWriteAccess` (synchronous): the member's permission for
 *    the operation and an accessible, active target matter. Chat runs it at
 *    tool registration, so a tool that writes documents cannot be built
 *    without a `DocumentWriteAccess` for its target.
 * 2. `authorizeDocumentWrite` (per write): consumes that access and checks the
 *    target entity of a new version (present in the matter, not read-only)
 *    before any bytes are produced. The version transaction repeats the
 *    entity checks under row locks, so this step is a fast refusal, not the
 *    serialization point.
 *
 * Folder targets and the matter status of a create are checked again inside
 * `createEntityFromBuffer`'s transaction, under the workspace and parent row
 * locks, because a create's access can be minted well before the write.
 */
export type CreateDocumentOperation = {
  type: "create";
  workspaceId: SafeId<"workspace">;
};

export type NewDocumentVersionOperation = {
  type: "new_version";
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

export type DocumentWriteOperation =
  | CreateDocumentOperation
  | NewDocumentVersionOperation;

type DocumentWriteOperationType = DocumentWriteOperation["type"];

const DOCUMENT_WRITE_PERMISSIONS = {
  create: { entity: ["create"] },
  new_version: { entity: ["update"] },
} as const satisfies Record<DocumentWriteOperationType, PermissionInput>;

export type DocumentWriteRefusalCode =
  | "forbidden"
  | "workspace-not-found"
  | "workspace-not-active"
  | "entity-not-found"
  | "entity-read-only";

const DOCUMENT_WRITE_REFUSAL_MESSAGES = {
  forbidden: "Forbidden",
  "workspace-not-found": "Matter not found or not accessible",
  "workspace-not-active": "The document's matter is archived or unavailable",
  "entity-not-found": "Entity not found",
  "entity-read-only": "Entity is read-only",
} as const satisfies Record<DocumentWriteRefusalCode, string>;

export class DocumentWriteRefusedError extends TaggedError(
  "DocumentWriteRefusedError",
)<{
  code: DocumentWriteRefusalCode;
  message: string;
}> {}

export const documentWriteRefusal = (
  code: DocumentWriteRefusalCode,
): DocumentWriteRefusedError =>
  new DocumentWriteRefusedError({
    code,
    message: DOCUMENT_WRITE_REFUSAL_MESSAGES[code],
  });

const refuse = (code: DocumentWriteRefusalCode) =>
  Result.err(documentWriteRefusal(code));

class DocumentWriteAccessProof<TOperation extends DocumentWriteOperation> {
  readonly #operation: TOperation;
  constructor(operation: TOperation) {
    this.#operation = operation;
  }
  get operation(): TOperation {
    return this.#operation;
  }
}

class AuthorizedDocumentWriteProof<TOperation extends DocumentWriteOperation> {
  readonly #operation: TOperation;
  constructor(operation: TOperation) {
    this.#operation = operation;
  }
  get operation(): TOperation {
    return this.#operation;
  }
}

/** Member permission and matter checks passed for `operation`. */
export type DocumentWriteAccess<
  TOperation extends DocumentWriteOperation = DocumentWriteOperation,
> = DocumentWriteAccessProof<TOperation>;

/** Every check passed for `operation`; the ids to write come from here. */
type AuthorizedDocumentWrite<
  TOperation extends DocumentWriteOperation = DocumentWriteOperation,
> = AuthorizedDocumentWriteProof<TOperation>;

type AuthorizeDocumentWriteAccessOptions<
  TOperation extends DocumentWriteOperation,
> = {
  authority: AuthorizedMemberRole;
  /**
   * The member's resolved view of the target matter, or `null` when it is
   * not accessible. A workspace whose id differs from the operation's is
   * treated as not accessible.
   */
  workspace: AccessibleWorkspace | null;
  operation: TOperation;
};

export const authorizeDocumentWriteAccess = <
  TOperation extends DocumentWriteOperation,
>({
  authority,
  workspace,
  operation,
}: AuthorizeDocumentWriteAccessOptions<TOperation>): Result<
  DocumentWriteAccess<TOperation>,
  DocumentWriteRefusedError
> => {
  if (
    !hasMemberPermission(authority, DOCUMENT_WRITE_PERMISSIONS[operation.type])
  ) {
    return refuse("forbidden");
  }
  if (workspace === null || workspace.id !== operation.workspaceId) {
    return refuse("workspace-not-found");
  }
  if (workspace.status !== "active") {
    return refuse("workspace-not-active");
  }
  return Result.ok(new DocumentWriteAccessProof(operation));
};

type AuthorizeDocumentWriteOptions<TOperation extends DocumentWriteOperation> =
  {
    access: DocumentWriteAccess<TOperation>;
    safeDb: SafeDb;
  };

export const authorizeDocumentWrite = async <
  TOperation extends DocumentWriteOperation,
>({
  access,
  safeDb,
}: AuthorizeDocumentWriteOptions<TOperation>): Promise<
  Result<
    AuthorizedDocumentWrite<TOperation>,
    DocumentWriteRefusedError | SafeDbError
  >
> => {
  // Widened to the union so the switch narrows it; the proof keeps the
  // caller's operation type.
  const operation: DocumentWriteOperation = access.operation;
  switch (operation.type) {
    case "create": {
      return Result.ok(new AuthorizedDocumentWriteProof(access.operation));
    }
    case "new_version": {
      const entity = await safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: operation.entityId },
            workspaceId: { eq: operation.workspaceId },
          },
          columns: { currentVersionId: true, readOnly: true },
        }),
      );
      if (Result.isError(entity)) {
        return Result.err(entity.error);
      }
      if (!entity.value?.currentVersionId) {
        return refuse("entity-not-found");
      }
      if (entity.value.readOnly) {
        return refuse("entity-read-only");
      }
      return Result.ok(new AuthorizedDocumentWriteProof(access.operation));
    }
    default: {
      operation satisfies never;
      return panic(`Unhandled document write operation: ${String(operation)}`);
    }
  }
};

const DOCUMENT_WRITE_REFUSAL_HTTP_STATUS = {
  forbidden: 403,
  "workspace-not-found": 404,
  "workspace-not-active": 409,
  "entity-not-found": 404,
  "entity-read-only": 409,
} as const satisfies Record<DocumentWriteRefusalCode, number>;

export const documentWriteRefusalHandlerError = ({
  code,
  message,
}: DocumentWriteRefusedError): HandlerError =>
  new HandlerError({
    status: DOCUMENT_WRITE_REFUSAL_HTTP_STATUS[code],
    message,
  });

const DOCUMENT_WRITE_REFUSAL_CHAT_TOOL_ERROR_KIND = {
  forbidden: "unavailable",
  "workspace-not-found": "not-found",
  "workspace-not-active": "unavailable",
  "entity-not-found": "not-found",
  "entity-read-only": "invalid-input",
} as const satisfies Record<DocumentWriteRefusalCode, ChatToolErrorKind>;

export const documentWriteRefusalChatToolError = (
  error: DocumentWriteRefusedError,
): ChatToolError =>
  new ChatToolError({
    kind: DOCUMENT_WRITE_REFUSAL_CHAT_TOOL_ERROR_KIND[error.code],
    message: error.message,
    cause: error,
  });
