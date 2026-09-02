import type {
  EntityPriority,
  OcrExportStatus,
  ReviewFlag,
  TaskStatus,
} from "@stll/api-contract";
import type { ListItemType } from "@stll/api-contract/entity-options";
import type {
  OptionColor,
  WorkspaceFieldContent,
} from "@stll/workspace-ui/types";

import { PDF_MIME_TYPE } from "@/consts";
import type {
  BoundingBox,
  AgendaItemKind,
  AgendaItemSource,
  ConditionNode,
  EntityKind,
  ViewLayout,
  ViewLayoutType,
  SafeId,
  WorkspacePropertyWire,
} from "@/lib/api-contract";
import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  isEmailFile,
  isMarkdownFile,
} from "@/lib/consts";
import type { FileRouteTypes } from "@/routeTree.gen";

export type { OptionColor, WorkspaceFieldContent };

export type {
  EntityKind,
  ConditionNode,
  AgendaItemKind,
  AgendaItemSource,
  ViewLayout,
  ViewLayoutType,
  ViewTemplateProperty,
} from "@/lib/api-contract";

export type RouterToPath = FileRouteTypes["to"];
export type RouterFullPath = FileRouteTypes["fullPaths"];

export type WorkspaceId = SafeId<"workspace">;
export type EntityId = SafeId<"entity">;
export type FieldId = SafeId<"field">;
export type JustificationId = SafeId<"justification">;
export type PropertyId = SafeId<"property">;

export const isFileDisplayable = (file: {
  mimeType: string;
  fileName?: string | null | undefined;
  pdfFileId: string | null;
  encrypted: boolean;
}) => {
  if (file.mimeType === PDF_MIME_TYPE) {
    return true;
  }

  if (file.pdfFileId !== null) {
    return true;
  }

  // OOXML files are rendered natively in-browser.
  if (
    file.mimeType === DOCX_MIME ||
    getNativeOfficeViewerFormat(file.mimeType) !== null
  ) {
    return true;
  }

  if (!file.encrypted && isEmailFile(file)) {
    return true;
  }

  if (!file.encrypted && isMarkdownFile(file)) {
    return true;
  }

  return false;
};

export type PropertyDependency = {
  dependsOnPropertyId: PropertyId;
  condition: ConditionNode | null;
};

type ManualInputTool = {
  version: 1;
  type: "manual-input";
  dependencies?: PropertyDependency[];
};

type AIModelTool = {
  version: 1;
  type: "ai-model";
  prompt: string;
  dependencies: PropertyDependency[];
};

// A system-computed playbook verdict column. The value is a single-select tier
// (compliant / fallback / deviation / missing) written by the verdict engine;
// the cell is read-only on the client. `askPropertyId` is the ASK property this
// verdict grades: the table pairs the two back together into one
// compliance-matrix cell (extracted value + verdict badge) instead of rendering
// two disjoint columns. The rest of the grading inputs (rule/standard/severity)
// live server-side and the client never reads them.
type PlaybookVerdictTool = {
  version: 1;
  type: "playbook-verdict";
  askPropertyId: PropertyId;
  dependencies: PropertyDependency[];
};

// Derived from the wire shape (`WorkspacePropertyWire`) rather than
// hand-listed: a column the API starts projecting appears here without an
// edit, and a field named here that the API stops sending becomes a type
// error at the one place (`toWorkspaceProperty`) that builds this type from
// the response, instead of silently drifting out of sync.
export type WorkspaceProperty = Omit<
  WorkspacePropertyWire,
  "id" | "workspaceId" | "tool" | "kinds" | "role" | "content"
> & {
  id: PropertyId;
  workspaceId: WorkspaceId;
  /**
   * The entity kinds the property applies to; null means every kind. A view
   * scoped to one kind offers only the properties that apply to it.
   */
  kinds: WorkspacePropertyWire["kinds"];
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
      }
    | {
        version: 1;
        type: "money";
        /** Currency new values default to; null when each value carries its own. */
        currency: string | null;
      }
    | {
        version: 1;
        type: "person";
      };
  tool: ManualInputTool | AIModelTool | PlaybookVerdictTool;
  // Structural role: identifies the document-type classifier by identity
  // rather than by the literal name "Document Type" (mirrors the server
  // `properties.role` column). Optional because not every property source
  // carries it; absent/null means an ordinary property.
  role?: WorkspacePropertyWire["role"];
};

export type WorkspacePropertyOption = {
  color: OptionColor;
  value: string;
};

export type { OcrExportStatus };

export type WorkspaceField = {
  entityId: EntityId;
  id: FieldId;
  propertyId: PropertyId;
  content: WorkspaceFieldContent;
  ocrExportStatus?: OcrExportStatus;
};

export type WorkspaceCellMetadata = {
  version: 1;
  /** The shared reviewer vocabulary (see `REVIEW_FLAGS`), the same list a
   *  document-review finding's flags come from. */
  manualFlags: ReviewFlag[];
  flagProvenance?: Record<
    string,
    {
      addedBy: string;
      addedAt: string;
      addedByName: string | null;
      addedByImage: string | null;
    }
  >;
  locked?: boolean;
  lockProvenance?: {
    lockedBy: string;
    lockedAt: string;
    lockedByName: string | null;
    lockedByImage: string | null;
    reason: "manual-edit" | "explicit";
  };
};

export type EntityField = {
  id: FieldId;
  propertyId: PropertyId;
  content: WorkspaceFieldContent;
};

export type WorkspaceEntity = {
  entityId: EntityId;
  kind: EntityKind;
  name: string | null;
  parentId: EntityId | null;
  createdAt: string;
  createdBy: string | null;
  createdByUserId: string | null;
  createdByImage: string | null;
  createdByDeletedAt: string | null;
  updatedAt: string | null;
  version: number;
  /** Task workflow status; malformed legacy wire values are normalized to null. */
  status: TaskStatus | null;
  /** Task priority; malformed legacy wire values are normalized to null. */
  priority: EntityPriority | null;
  /** Legal-list discriminator; malformed legacy wire values are normalized to null. */
  listItemType: ListItemType | null;
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
  fields: Partial<Record<PropertyId, WorkspaceField>>;
  cellMetadata: Partial<Record<PropertyId, WorkspaceCellMetadata>>;
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

export type PersonMention = {
  name: string;
  image: string | null;
  deletedAt?: string | null;
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

/** A DOCX citation, discriminated by whether its quote was grounded
 *  against an allow-listed source block server-side.
 *
 *  - `verified`: the quote matched a real block; carries the block's
 *    literal text (rendered as the quote) and the `blockId` the folio
 *    editor scrolls to.
 *  - `unverified`: the model's quote matched no source block, so there
 *    is no navigable block; the client renders the raw text as a
 *    non-navigable hint. */
export type DocxFolioJustificationCitation =
  | { citationStatus: "verified"; blockId: string; text: string }
  | { citationStatus: "unverified"; text: string };

export type DocxFolioJustificationBlock = {
  kind: "docx-folio";
  fileFieldId: string;
  statements: {
    text: string;
    citations: DocxFolioJustificationCitation[];
  }[];
};

// A playbook verdict's provenance. Unlike the document-citation blocks above it
// carries no file/page/block reference: a verdict grades the already-extracted
// ASK value against the position's tiers, so the provenance is the model's
// rationale plus, when the tier decision hinged on specific authored language,
// the matched fallback option or violated red-line rule.
export type VerdictMatchedRef =
  | { kind: "fallback"; label?: string; text: string }
  | { kind: "redLine"; ruleId: string; text: string };

export type VerdictRationaleJustificationBlock = {
  kind: "playbook-verdict";
  rationale: string;
  matchedRef?: VerdictMatchedRef;
};

export type JustificationBlock =
  | PdfBatesJustificationBlock
  | DocxFolioJustificationBlock
  | VerdictRationaleJustificationBlock;

export type JustificationContent = {
  version: 1;
  blocks: JustificationBlock[];
};

export type WorkspaceJustification = {
  id: JustificationId;
  fieldId: FieldId;
  content: JustificationContent;
  boundingBoxes: { version: number; boxes: BoundingBox[] } | null;
  fileFieldIds: FieldId[];
};
