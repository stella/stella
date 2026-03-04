import { FileTextIcon, FolderIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { isFileDisplayable } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const ENTITY_HASH_PREFIX = "#stella-entity=";

/** Open the entity's file in the peek panel. */
export const openEntityInPeek = (entityId: string, label: string) => {
  const entities = useWorkspaceStore.getState().data;
  const entity = entities.find((e) => e.entityId === entityId);
  if (!entity) {
    return;
  }

  for (const field of Object.values(entity.fields)) {
    if (field.content.type === "file" && isFileDisplayable(field.content)) {
      usePeekStore.getState().openTab({
        fieldId: field.id,
        entityId,
        label,
      });
      return;
    }
  }
};

/** Resolve the icon for an entity by its ID. */
export const EntityMentionIcon = ({ entityId }: { entityId: string }) => {
  const entity = useWorkspaceStore((s) =>
    s.data.find((e) => e.entityId === entityId),
  );
  const file = entity ? getFirstFile(entity) : null;
  const kind = entity?.kind ?? "document";

  if (kind === "folder") {
    return <FolderIcon className="inline size-3 shrink-0" />;
  }
  if (file?.mimeType) {
    return (
      <DocumentIcon
        className="inline size-3 shrink-0"
        mimeType={file.mimeType}
      />
    );
  }
  return <FileTextIcon className="inline size-3 shrink-0" />;
};

/** Renders `#stella-entity=` links as clickable document
 *  references; all other links render as normal anchors. */
export const EntityLink = ({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
  if (href?.startsWith(ENTITY_HASH_PREFIX)) {
    const entityId = href.slice(ENTITY_HASH_PREFIX.length);
    const label = typeof children === "string" ? children : "Document";

    return (
      <button
        className={cn(
          "inline-flex items-center gap-0.5",
          "text-foreground underline decoration-muted-foreground/40",
          "underline-offset-2 transition-colors",
          "cursor-pointer hover:decoration-foreground",
        )}
        onClick={() => openEntityInPeek(entityId, label)}
        type="button"
      >
        <EntityMentionIcon entityId={entityId} />
        {children}
      </button>
    );
  }

  return (
    <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
};
