import type { KanbanColumnBand } from "@stll/ui/kanban";
import type { OptionColor } from "@stll/ui/option-color";

export type { OptionColor } from "@stll/ui/option-color";

export type FieldContent =
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
      /**
       * A monetary amount. Separate from `int` because it is stored in minor
       * units and carries its own currency: an int's value is major units, so
       * one type for both is a 100x bug waiting in every total.
       */
      type: "money";
      version: 1;
      amountCents: number;
      currency: string;
    }
  | {
      type: "person";
      version: 1;
      /** Null when the person is named but not a workspace member. */
      userId: string | null;
      name: string;
      image: string | null;
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

const fieldContentTypes = [
  "error",
  "pending",
  "unsupported",
  "text",
  "single-select",
  "multi-select",
  "file",
  "date",
  "int",
  "money",
  "person",
  "clip",
] as const;

type CompleteFieldContentTypes<T extends readonly FieldContent["type"][]> =
  Exclude<FieldContent["type"], T[number]> extends never ? T : never;

/** Runtime names for every content arm the field renderer understands. */
export const FIELD_CONTENT_TYPES =
  fieldContentTypes satisfies CompleteFieldContentTypes<
    typeof fieldContentTypes
  >;

export type WorkspaceFieldContent = FieldContent;

/**
 * Minimal structural bound the display layer needs from a property: the cell
 * renderers only read `content.type` and, for selects, the `options` colors.
 * Real callers (e.g. the app's `WorkspaceProperty`) satisfy this structurally.
 */
export type GenericProperty = {
  content:
    | { type: "file" | "text" | "date" | "int" | "money" | "person" }
    | {
        type: "single-select" | "multi-select";
        options: {
          value: string;
          color: OptionColor;
          /** The column band this option's column joins, when the board bands. */
          band?: KanbanColumnBand | undefined;
        }[];
      };
};
