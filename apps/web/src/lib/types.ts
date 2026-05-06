import type {
  BoundingBox,
  AgendaItemKind,
  AgendaItemSource,
  EntityKind,
  OptionColor,
  PropertyCondition,
  ViewLayout,
  ViewLayoutType,
} from "@stll/api/types";

import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME } from "@/lib/consts";
import type { FileRouteTypes } from "@/routeTree.gen";

export type {
  EntityKind,
  ViewFilterCondition,
  AgendaItemKind,
  AgendaItemSource,
  ViewLayout,
  ViewLayoutType,
} from "@stll/api/types";

export type RouterToPath = FileRouteTypes["to"];
export type RouterFullPath = FileRouteTypes["fullPaths"];

export const isFileDisplayable = (file: {
  mimeType: string;
  pdfFileId: string | null;
  encrypted: boolean;
}) => {
  if (file.mimeType === PDF_MIME_TYPE) {
    return true;
  }

  if (file.pdfFileId !== null) {
    return true;
  }

  // DOCX files are rendered natively via Folio
  if (file.mimeType === DOCX_MIME) {
    return true;
  }

  return false;
};

export type PropertyDependency = {
  dependsOnPropertyId: string;
  condition: PropertyCondition | null;
};

type ManualInputTool = {
  version: 1;
  type: "manual-input";
};

type AIModelTool = {
  version: 1;
  type: "ai-model";
  prompt: string;
  dependencies: PropertyDependency[];
};

export type WorkspaceProperty = {
  id: string;
  name: string;
  createdAt: Date;
  workspaceId: string;
  status: "stale" | "fresh";
  content:
    | {
        version: 1;
        type: "file";
      }
    | {
        version: 1;
        type: "text";
      }
    | {
        version: 1;
        type: "single-select" | "multi-select";

        options: {
          value: string;
          color: OptionColor;
        }[];
        fallback: string | null;
      }
    | {
        version: 1;
        type: "date";
      }
    | {
        version: 1;
        type: "int";
      };
  tool: ManualInputTool | AIModelTool;
};

export type WorkspaceToolType = WorkspaceProperty["tool"]["type"];

export type WorkspacePropertyOption = {
  color: OptionColor;
  value: string;
};

export type WorkspaceFieldContent =
  | {
      type: "error";
      version: 1;
    }
  | {
      type: "pending";
      version: 1;
    }
  | {
      type: "unsupported";
      version: 1;
    }
  | {
      type: "text";
      version: 1;
      value: string;
    }
  | {
      type: "single-select";
      version: 1;
      value: string | null;
    }
  | {
      type: "multi-select";
      version: 1;
      value: string[];
    }
  | {
      type: "file";
      version: 1;
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      encrypted: boolean;
      sha256Hex: string;
      pdfFileId: string | null;
    }
  | {
      type: "date";
      version: 1;
      value: string | null;
    }
  | {
      type: "int";
      version: 1;
      value: number;
      currency: string | null;
    }
  | {
      type: "clip";
      version: 1;
      url: string;
      snippet?: string;
      citation?: string;
      jurisdiction?: string;
      sourceType?: string;
    };

export type WorkspaceField = {
  entityId: string;
  id: string;
  content: WorkspaceFieldContent;
};

export type WorkspaceCellMetadata = {
  version: 1;
  manualFlags: string[];
  flagProvenance?: Record<
    string,
    {
      addedBy: string;
      addedAt: string;
      addedByName: string | null;
      addedByImage: string | null;
    }
  >;
};

export type EntityField = {
  id: string;
  propertyId: string;
  content: WorkspaceFieldContent;
};

export type WorkspaceEntity = {
  entityId: string;
  kind: EntityKind;
  name: string | null;
  parentId: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByImage: string | null;
  updatedAt: string | null;
  version: number;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  agendaKind: AgendaItemKind;
  startAt: string | null;
  endAt: string | null;
  occurredAt: string | null;
  remindAt: string | null;
  allDay: boolean;
  timeZone: string | null;
  location: string | null;
  onlineMeetingUrl: string | null;
  availability: string | null;
  sensitivity: string | null;
  organizer: unknown;
  attendees: unknown;
  recurrence: unknown;
  agendaSource: AgendaItemSource;
  externalSource: string | null;
  externalId: string | null;
  externalChangeKey: string | null;
  externalICalUid: string | null;
  readOnly: boolean;
  sortOrder: string | null;
  activeEditBy: { name: string; image: string | null; isMe: boolean } | null;
  fields: Record<string, WorkspaceField>;
  cellMetadata: Record<string, WorkspaceCellMetadata>;
};

export type WorkspaceView<T extends ViewLayoutType = ViewLayoutType> = {
  version: number;
  id: string;
  name: string;
  layout: Extract<ViewLayout, { type: T }>;
  position: number;
  createdAt: string;
};

// ── Inline mention types ─────────────────────────────────
// Default renders icon/avatar; callers must explicitly
// opt out via hideIcon / hideAvatar.

export type FileMention = {
  name: string;
  mimeType: string;
  /** Only set when space is extremely constrained. */
  hideIcon?: boolean;
};

export type PersonMention = {
  name: string;
  image: string | null;
  /** Only set when space is extremely constrained. */
  hideAvatar?: boolean;
};

export type PdfBatesJustificationBlock = {
  kind: "pdf-bates";
  fileFieldId: string;
  statements: {
    text: string;
    citations: {
      bates: string;
      pageNumber: number;
    }[];
  }[];
};

export type DocxFolioJustificationBlock = {
  kind: "docx-folio";
  fileFieldId: string;
  statements: {
    text: string;
    /** Each cite carries the block's literal text captured at
     *  extraction time so the cell-click peek can render the quoted
     *  source without re-fetching anything. `blockId` matches the
     *  folio editor's block IDs (Phase 2b: scroll-to-block). */
    citations: {
      blockId: string;
      text: string;
    }[];
  }[];
};

export type JustificationBlock =
  | PdfBatesJustificationBlock
  | DocxFolioJustificationBlock;

export type JustificationContent = {
  version: 1;
  blocks: JustificationBlock[];
};

export type WorkspaceJustification = {
  id: string;
  fieldId: string;
  content: JustificationContent;
  boundingBoxes: { version: number; boxes: BoundingBox[] } | null;
  fileFieldIds: string[];
};
