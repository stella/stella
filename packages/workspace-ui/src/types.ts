import type { KanbanColumnBand } from "@stll/ui/kanban";
import type { OptionColor } from "@stll/ui/option-color";

export type { OptionColor } from "@stll/ui/option-color";

/**
 * Why a document could not be converted. Mirrors the API contract type; the
 * web app asserts both declarations stay equal.
 */
export type FileConversionRefusal =
  | { kind: "unsupported_encoding"; encoding: string }
  | {
      kind: "unsupported_reference";
      format: string;
      element: string;
      attribute: string;
    }
  | { kind: "unsupported_field"; fieldType: string }
  | { kind: "legacy_format"; replacementExtension: ".xlsx" | ".pptx" };

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
      pdfDerivative?:
        | { status: "not-required" | "pending" | "ready" }
        | {
            status: "failed";
            reason?: "enqueue" | "processing" | "too-large" | undefined;
            conversionRefusal?: FileConversionRefusal | undefined;
          }
        | undefined;
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
    }
  | {
      /**
       * Typed records from a data source or a structured AI answer. The
       * column's schema names the fields; the cell holds their values.
       */
      type: "record";
      version: 1;
      schemaVersion: number;
      state: RecordFieldState;
    };

export type RecordFieldScalar =
  string | number | boolean | { amountMinor: number; currency: string } | null;

export type RecordFieldRecord = Record<string, RecordFieldScalar>;

export type RecordFieldProvenance = {
  url: string;
  retrievedAt: string;
  sha256: string;
  sourceDataAsOf?: string;
};

export type RecordFieldState =
  | {
      /** The tool refused its input; the source was not called. */
      status: "input-needs-review";
      input: RecordFieldRecord;
      issues: {
        key: string;
        code: "missing" | "invalid" | "uncertain";
        message: string;
      }[];
    }
  | {
      status: "not-found";
      input: RecordFieldRecord;
      provenance: RecordFieldProvenance;
    }
  | {
      status: "resolved";
      input?: RecordFieldRecord;
      provenance?: RecordFieldProvenance;
      result:
        | { kind: "one"; record: RecordFieldRecord }
        | {
            /** Ambiguous for `candidates` until a person selects one. */
            kind: "many" | "candidates";
            records: RecordFieldRecord[];
            selected: number | null;
          };
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
  "record",
] as const;

type CompleteFieldContentTypes<T extends readonly FieldContent["type"][]> =
  Exclude<FieldContent["type"], T[number]> extends never ? T : never;

/** Runtime names for every content arm the field renderer understands. */
export const FIELD_CONTENT_TYPES =
  fieldContentTypes satisfies CompleteFieldContentTypes<
    typeof fieldContentTypes
  >;

export type WorkspaceFieldContent = FieldContent & { truncated?: true };

/**
 * Minimal structural bound the display layer needs from a property: the cell
 * renderers only read `content.type` and, for selects, the `options` colors.
 * Real callers (e.g. the app's `WorkspaceProperty`) satisfy this structurally.
 */
export type GenericProperty = {
  content:
    | {
        type: "file" | "text" | "date" | "int" | "money" | "person" | "record";
      }
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
