import type {
  BoundingBox,
  EntityKind,
  OptionColor,
  PropertyCondition,
  ViewLayout,
  ViewLayoutType,
} from "@stella/api/types";

import { PDF_MIME_TYPE } from "@/consts";
import type { FileRouteTypes } from "@/routeTree.gen";

export type {
  EntityKind,
  ViewFilterCondition,
  ViewLayout,
  ViewLayoutType,
} from "@stella/api/types";

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
  status: "uninitialized" | "stale" | "fresh";
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
    };

export type WorkspaceField = {
  entityId: string;
  id: string;
  content: WorkspaceFieldContent;
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
  sortOrder: string | null;
  fields: Record<string, WorkspaceField>;
};

export type WorkspaceView<T extends ViewLayoutType = ViewLayoutType> = {
  version: number;
  id: string;
  name: string;
  layout: Extract<ViewLayout, { type: T }>;
  position: number;
  createdAt: string;
};

export type WorkspaceJustification = {
  id: string;
  fieldId: string;
  htmlVersion: number;
  htmlContent: string;
  boundingBoxes: { version: number; boxes: BoundingBox[] } | null;
  fileFieldIds: string[];
};
