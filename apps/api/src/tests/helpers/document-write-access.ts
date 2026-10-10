import { authorizeDocumentWriteAccess } from "@/api/lib/entities/authorize-document-write";
import type { DocumentWriteOperation } from "@/api/lib/entities/authorize-document-write";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

/**
 * Write access a `member` session holds on an active matter, minted through
 * the production gate so tests of document-writing tools never construct the
 * proof any other way.
 */
export const memberDocumentWriteAccess = <
  TOperation extends DocumentWriteOperation,
>(
  operation: TOperation,
) =>
  authorizeDocumentWriteAccess({
    authority: sessionMemberRole("member"),
    workspace: { id: operation.workspaceId, status: "active" },
    operation,
  }).unwrap();
