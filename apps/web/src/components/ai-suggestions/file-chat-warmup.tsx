/**
 * The two reads the file chat overlay makes before it can draw anything: the
 * file's thread binding, and the MCP catalogue its chat session reads once the
 * binding resolves.
 *
 * The overlay ships inside the DOCX editor, and the editor arrives in its own
 * chunk, so leaving these to the overlay puts a chunk fetch in front of them
 * and turns each into a later sequential round (route-smoke's waterfall guard
 * counts them). Mounted beside the editor's slot, this starts both the moment
 * the surface is known, so the editor lands on a warm binding instead of
 * opening one.
 *
 * Both calls go through the same option factories the overlay uses, so the
 * cache entries are the ones it looks up, not copies of them.
 */

import { useQuery } from "@tanstack/react-query";

import { fileChatThreadOptions } from "@/features/chat/queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";

type FileChatWarmupProps = {
  entityId: string;
  fileFieldId: string;
  workspaceId: string;
};

export const FileChatWarmup = ({
  entityId,
  fileFieldId,
  workspaceId,
}: FileChatWarmupProps) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  useQuery(
    fileChatThreadOptions({
      activeOrganizationId,
      key: { entityId, fieldId: fileFieldId, workspaceId },
      // The DOCX surface always wires a live editor ref, so the binding seeds
      // the same sibling cache key the overlay will read there.
      hasDocxEditSurface: true,
    }),
  );
  useQuery(mcpConnectorsOptions(activeOrganizationId));

  return null;
};
