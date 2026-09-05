import { panic } from "better-result";
import {
  CircleDashedIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  LinkIcon,
  ListTodoIcon,
  MailIcon,
} from "lucide-react";

import { cn } from "@stll/ui/utils";

import { DocumentIcon } from "@/components/document-icon";
import {
  STATUS_COLORS,
  STATUS_ICONS,
  isTaskStatus,
} from "@/components/workspaces/tasks/task-detail-constants";
import type { EntityKind } from "@/lib/types";

/**
 * What a renderer knows about the entity it is drawing an icon for.
 *
 * `pending` and `unknown` exist so a caller that has not resolved the
 * entity yet cannot express its ignorance as a document: an icon picked
 * from a proxy signal (the visible label, the presence of a mime type) is
 * wrong in a way that looks right, which is how chat mentions came to draw
 * folders and tasks as documents.
 */
export type EntityIconSource =
  | {
      type: "resolved";
      kind: EntityKind;
      fileName?: string | null | undefined;
      mimeType?: string | null | undefined;
      /** Task status, when the caller has it. Absent means "a task", not
       *  "an open task". */
      status?: string | null | undefined;
    }
  | { type: "pending" }
  | { type: "unknown" };

/** Draws an entity's icon from whatever the caller actually knows. */
export const EntityIcon = ({
  source,
  className,
}: {
  source: EntityIconSource;
  className?: string | undefined;
}) => {
  switch (source.type) {
    case "resolved":
      return (
        <EntityKindIcon
          className={className}
          fileName={source.fileName}
          kind={source.kind}
          mimeType={source.mimeType}
          status={source.status}
        />
      );
    case "pending":
      return (
        <CircleDashedIcon
          className={cn("text-muted-foreground animate-pulse", className)}
        />
      );
    case "unknown":
      return (
        <CircleDashedIcon className={cn("text-muted-foreground", className)} />
      );
    default: {
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
    }
  }
};

/** Whether a folder is drawn open or shut. Only trees and tables that own
 *  an expand affordance know this; everything else draws a shut folder. */
export type FolderState = "collapsed" | "expanded";

type EntityKindIconProps = {
  kind: EntityKind;
  className?: string | undefined;
  fileName?: string | null | undefined;
  folderState?: FolderState | undefined;
  mimeType?: string | null | undefined;
  status?: string | null | undefined;
};

/**
 * The single kind -> glyph mapping. The `switch` is exhaustive over
 * `EntityKind` (see the `never` default), so a kind added to
 * `ENTITY_KINDS` fails to typecheck here until someone gives it a glyph,
 * instead of silently inheriting the document fallback.
 */
export const EntityKindIcon = ({
  kind,
  className,
  fileName,
  folderState,
  mimeType,
  status,
}: EntityKindIconProps) => {
  switch (kind) {
    case "task": {
      // A status icon states a status. Without one, say "task" rather than
      // defaulting to "open" and mislabelling every done task.
      const statusKey = status ?? null;
      if (!isTaskStatus(statusKey)) {
        return <ListTodoIcon className={className} />;
      }
      const Icon = STATUS_ICONS[statusKey];
      return <Icon className={cn(STATUS_COLORS[statusKey], className)} />;
    }
    case "folder":
      return folderState === "expanded" ? (
        <FolderOpenIcon className={className} />
      ) : (
        <FolderIcon className={className} />
      );
    case "message":
      return <MailIcon className={className} />;
    case "link":
      return <LinkIcon className={className} />;
    case "document":
      return mimeType || fileName ? (
        <DocumentIcon
          className={className}
          fileName={fileName}
          mimeType={mimeType}
        />
      ) : (
        <FileIcon className={className} />
      );
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};
