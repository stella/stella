/** Named preset or arbitrary 6-character hex color (e.g. "FF0000"). */
export type OptionColor =
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "gray"
  | (string & Record<never, never>);

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
      type: "clip";
      version: 1;
      url: string;
      snippet?: string;
      citation?: string;
      jurisdiction?: string;
      sourceType?: string;
    };

export type WorkspaceFieldContent = FieldContent;

/**
 * Minimal structural bound the display layer needs from a property: the cell
 * renderers only read `content.type` and, for selects, the `options` colors.
 * Real callers (e.g. the app's `WorkspaceProperty`) satisfy this structurally.
 */
export type GenericProperty = {
  content:
    | { type: "file" | "text" | "date" | "int" }
    | {
        type: "single-select" | "multi-select";
        options: { value: string; color: OptionColor }[];
      };
};
