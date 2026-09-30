import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
  type AdapterKey,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

import type { MarkupXmlDialect } from "./markup";
import { TEXT_FORMAT, type TextFormat } from "./types";

/** Transport paths, never parser layout selectors. `*` visits every array item. */
type SourceTextRecipe =
  | { readonly type: "envelope-text"; readonly part: string }
  | {
      readonly type: "html-input";
      readonly part: string;
      readonly id: string;
      readonly attribute: "value";
    }
  | {
      readonly type: "envelope-base64";
      readonly part: string;
      readonly contentTypePart: string;
      readonly contentType: string;
    }
  | {
      readonly type: "json-base64";
      readonly part: string;
      readonly path: readonly string[];
    }
  | {
      readonly type: "json-text";
      readonly part: string;
      /** Alternative representations; never concatenate a fulltext and its sections. */
      readonly alternatives: readonly (readonly (readonly string[])[])[];
      readonly textFormat: typeof TEXT_FORMAT.HTML | typeof TEXT_FORMAT.TEXT;
    }
  | {
      readonly type: "json-keyed-text";
      readonly part: string;
      readonly fieldsPath: readonly string[];
      readonly key: string;
      readonly keyProperty: string;
      readonly valueProperty: string;
      readonly textFormat: typeof TEXT_FORMAT.HTML | typeof TEXT_FORMAT.TEXT;
    }
  | {
      readonly type: "opinion-candidates";
      readonly part: "cl-opinions";
    }
  | {
      readonly type: "object";
      readonly part: string;
      /** The UOKiK producer appends `-2`, `-3`, etc. to its first object name. */
      readonly multiplicity: "single" | "numbered-family";
      /** Explicit direct-byte cutover for a deferred document captured without an envelope. */
      readonly directContentType?: string;
    };

type SourceFormatBranch =
  | {
      readonly format: typeof TEXT_FORMAT.XML;
      readonly xmlDialect: MarkupXmlDialect;
      readonly recipe: SourceTextRecipe;
    }
  | {
      readonly format: Exclude<TextFormat, typeof TEXT_FORMAT.XML>;
      readonly recipe: SourceTextRecipe;
    };

export type SourceFormat = {
  readonly branches: readonly [SourceFormatBranch, ...SourceFormatBranch[]];
};

/** Transport precedence shared with parsing; scan XML requires assets rather than a text oracle. */
export const COURTLISTENER_TEXT_FORMATS = [
  "xml_harvard",
  "html_with_citations",
  "html_lawbox",
  "html_columbia",
  "html_anon_2020",
  "html",
  "plain_text",
] as const;

const RIS_FORMAT = {
  branches: [
    {
      format: TEXT_FORMAT.XML,
      xmlDialect: "ris",
      recipe: { type: "envelope-text", part: "document-xml" },
    },
  ],
} as const satisfies SourceFormat;

/** Current captured payloads only. Legacy shapes remain owned by LEGACY_RAW_SHAPES. */
export const ADAPTER_SOURCE_FORMATS = {
  [ADAPTER_KEYS.CZ_NS]: {
    branches: [
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "print" },
      },
    ],
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    branches: [
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "document" },
      },
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "text" },
      },
    ],
  },
  [ADAPTER_KEYS.CZ_US]: {
    branches: [
      {
        format: TEXT_FORMAT.RTF,
        recipe: {
          type: "html-input",
          part: "document",
          id: "docContentHidden",
          attribute: "value",
        },
      },
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "document" },
      },
    ],
  },
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    branches: [
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-text",
          part: "document",
          textFormat: TEXT_FORMAT.TEXT,
          alternatives: [
            [
              ["header", "*", "texts", "*", "text"],
              ["verdict", "*", "texts", "*", "text"],
              ["justification", "*", "texts", "*", "text"],
              ["information", "*", "texts", "*", "text"],
            ],
            [["verdictText"], ["justificationText"]],
          ],
        },
      },
    ],
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    branches: [
      {
        format: TEXT_FORMAT.PDF,
        recipe: {
          type: "object",
          part: "document-file",
          multiplicity: "single",
          directContentType: "application/pdf",
        },
      },
    ],
  },
  [ADAPTER_KEYS.SK_US]: {
    branches: [
      {
        format: TEXT_FORMAT.PDF,
        recipe: {
          type: "object",
          part: "document-file",
          multiplicity: "single",
        },
      },
    ],
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    branches: [
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-text",
          part: "detail",
          textFormat: TEXT_FORMAT.HTML,
          alternatives: [[["data", "textContent"]], [["textContent"]]],
        },
      },
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-text",
          part: "listing-dump",
          textFormat: TEXT_FORMAT.HTML,
          alternatives: [[["textContent"]]],
        },
      },
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-text",
          part: "listing-search",
          textFormat: TEXT_FORMAT.HTML,
          alternatives: [[["textContent"]]],
        },
      },
    ],
  },
  [ADAPTER_KEYS.PL_SN]: {
    branches: [
      {
        format: TEXT_FORMAT.PDF,
        recipe: { type: "json-base64", part: "document", path: ["raw"] },
      },
    ],
  },
  [ADAPTER_KEYS.PL_KIO]: {
    branches: [
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "document" },
      },
    ],
  },
  [ADAPTER_KEYS.PL_TK]: {
    branches: [
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "case-page" },
      },
    ],
  },
  [ADAPTER_KEYS.PL_NSA]: {
    branches: [
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-text",
          part: "row",
          textFormat: TEXT_FORMAT.TEXT,
          alternatives: [
            [["full_text"]],
            [
              ["thesis"],
              ["sentence"],
              ["reasons_for_judgment"],
              ["dissenting_opinion"],
            ],
          ],
        },
      },
    ],
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    branches: [
      {
        format: TEXT_FORMAT.XML,
        xmlDialect: "xpart",
        recipe: { type: "envelope-text", part: "document" },
      },
    ],
  },
  [ADAPTER_KEYS.AT_COURTS]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_VFGH]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_VWGH]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_BVWG]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_LVWG]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_ASYLGH]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_UBAS]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_UVS]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_VERG]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_UMSE]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_BKS]: RIS_FORMAT,
  [ADAPTER_KEYS.AT_FINDOK]: {
    branches: [
      {
        format: TEXT_FORMAT.XML,
        xmlDialect: "findok",
        recipe: { type: "envelope-text", part: "document-xml" },
      },
    ],
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    branches: [
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "envelope-text", part: "document" },
      },
      {
        format: TEXT_FORMAT.XML,
        xmlDialect: "formex",
        recipe: { type: "envelope-text", part: "formex" },
      },
    ],
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    branches: [
      {
        format: TEXT_FORMAT.DOCX,
        recipe: {
          type: "envelope-base64",
          part: "document",
          contentTypePart: "documentContentType",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
      {
        format: TEXT_FORMAT.RTF,
        recipe: {
          type: "envelope-base64",
          part: "document",
          contentTypePart: "documentContentType",
          contentType: "application/rtf",
        },
      },
    ],
  },
  [ADAPTER_KEYS.PL_KIS]: {
    branches: [
      {
        format: TEXT_FORMAT.JSON,
        recipe: {
          type: "json-keyed-text",
          part: "detail",
          fieldsPath: ["dokument", "fields"],
          key: "TRESC_INTERESARIUSZ",
          keyProperty: "key",
          valueProperty: "value",
          textFormat: TEXT_FORMAT.HTML,
        },
      },
      {
        format: TEXT_FORMAT.PDF,
        recipe: {
          type: "object",
          part: "document-pdf",
          multiplicity: "single",
        },
      },
    ],
  },
  [ADAPTER_KEYS.PL_UODO]: {
    branches: [
      {
        format: TEXT_FORMAT.XML,
        xmlDialect: "xpart",
        recipe: { type: "envelope-text", part: "body-xml" },
      },
    ],
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    branches: [
      {
        format: TEXT_FORMAT.PDF,
        recipe: {
          type: "object",
          part: "decision-file",
          multiplicity: "numbered-family",
        },
      },
      {
        format: TEXT_FORMAT.PDF,
        recipe: { type: "object", part: "ruling-file", multiplicity: "single" },
      },
    ],
  },
} as const satisfies Record<AdapterKey, SourceFormat>;

/** Candidate selection is independently checked; no transport metadata enters text. */
export const IMPORT_SOURCE_FORMATS = {
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: {
    branches: [
      {
        format: TEXT_FORMAT.XML,
        xmlDialect: "generic",
        recipe: { type: "opinion-candidates", part: "cl-opinions" },
      },
      {
        format: TEXT_FORMAT.HTML,
        recipe: { type: "opinion-candidates", part: "cl-opinions" },
      },
      {
        format: TEXT_FORMAT.TEXT,
        recipe: { type: "opinion-candidates", part: "cl-opinions" },
      },
    ],
  },
} as const satisfies Record<ImportSourceKey, SourceFormat>;
