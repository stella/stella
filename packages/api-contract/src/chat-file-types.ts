import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "./desktop-edit-file-types";
import { legalFileFormat } from "./document-format";
import { LEGAL_FILE_FORMATS } from "./legal-file-formats";

type ChatFileSource =
  "native" | "plain-text" | "docx-markdown" | "extracted-text";

const SHARED_INPUT_OUTPUT_FILE_TYPES = [
  { extensions: [".png"], source: "native", mimeType: "image/png" },
  { extensions: [".jpg", ".jpeg"], source: "native", mimeType: "image/jpeg" },
  { extensions: [".webp"], source: "native", mimeType: "image/webp" },
  { extensions: [".gif"], source: "native", mimeType: "image/gif" },
  { extensions: [".pdf"], source: "native", mimeType: "application/pdf" },
  {
    source: "docx-markdown",
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.extension],
    mimeType: DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType,
  },
  {
    source: "extracted-text",
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.extension],
    mimeType: DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType,
  },
  { extensions: [".txt"], source: "plain-text", mimeType: "text/plain" },
  { extensions: [".csv"], source: "plain-text", mimeType: "text/csv" },
  { extensions: [".md"], source: "plain-text", mimeType: "text/markdown" },
] as const;

export const CHAT_FILE_TYPE_CONFIG = [
  ...SHARED_INPUT_OUTPUT_FILE_TYPES,
  ...LEGAL_FILE_FORMATS.map(
    ({ extensions, mimeType }) =>
      ({
        extensions,
        mimeType,
        source: "extracted-text",
      }) as const,
  ),
] as const satisfies readonly {
  extensions: readonly string[];
  mimeType: string;
  source: ChatFileSource;
}[];

export const chatFileSource = (mimeType: string) =>
  CHAT_FILE_TYPE_CONFIG.find((entry) => entry.mimeType === mimeType)?.source;

export const CHAT_FILE_MIME_TYPES = CHAT_FILE_TYPE_CONFIG.map(
  ({ mimeType }) => mimeType,
);

export type ChatFileMimeType = (typeof CHAT_FILE_MIME_TYPES)[number];

export const isChatFileMimeType = (value: string): value is ChatFileMimeType =>
  CHAT_FILE_MIME_TYPES.some((mimeType) => mimeType === value);

/** Some system pickers supply a generic MIME type for otherwise identifiable files. */
export const chatFileMimeType = (
  name: string,
  mimeType: string | null | undefined,
): ChatFileMimeType | undefined => {
  const legal = legalFileFormat(mimeType, name);
  if (legal) {
    return legal.mimeType;
  }
  const declared = mimeType?.split(";").at(0)?.trim().toLowerCase();
  if (declared && isChatFileMimeType(declared)) {
    return declared;
  }
  const lower = name.toLowerCase();
  return SHARED_INPUT_OUTPUT_FILE_TYPES.find(({ extensions }) =>
    extensions.some((extension) => lower.endsWith(extension)),
  )?.mimeType;
};

export const CHAT_FILE_INPUT_ACCEPT = CHAT_FILE_TYPE_CONFIG.flatMap(
  ({ extensions }) => extensions,
).join(",");

/**
 * What a local run may hand back beyond what a chat accepts. An agent writes
 * HTML reports, and a chat's files are served inline from the bucket's origin,
 * so these are only ever stored as a run's output and only ever delivered as a
 * forced download (`isDownloadOnlyFileMimeType`). A chat never accepts one as
 * an attachment.
 */
const RUN_OUTPUT_ONLY_FILE_TYPE_CONFIG = [
  { extensions: [".html", ".htm"], mimeType: "text/html" },
] as const;

const RUN_OUTPUT_FILE_TYPE_CONFIG = [
  ...SHARED_INPUT_OUTPUT_FILE_TYPES,
  ...RUN_OUTPUT_ONLY_FILE_TYPE_CONFIG,
];

export type RunOutputMimeType =
  (typeof RUN_OUTPUT_FILE_TYPE_CONFIG)[number]["mimeType"];

/**
 * The type a run's output is stored as, read from its name; `null` when a run
 * may not hand back a file of that name. The sender declares nothing: the
 * scan then holds the bytes to this type.
 */
export const runOutputMimeTypeOf = (
  fileName: string,
): RunOutputMimeType | null => {
  const lower = fileName.toLowerCase();
  const found = RUN_OUTPUT_FILE_TYPE_CONFIG.find(({ extensions }) =>
    extensions.some((extension) => lower.endsWith(extension)),
  );
  return found?.mimeType ?? null;
};

/** The names a run's instructions may promise the member sees. */
export const RUN_OUTPUT_FILE_EXTENSIONS = RUN_OUTPUT_FILE_TYPE_CONFIG.flatMap(
  ({ extensions }) => extensions,
);

export const isRunOutputMimeType = (
  value: string,
): value is RunOutputMimeType =>
  RUN_OUTPUT_FILE_TYPE_CONFIG.some(({ mimeType }) => mimeType === value);

/**
 * A stored user file a browser must never render: every reader delivers it as
 * a forced download or refuses it.
 */
export const isDownloadOnlyFileMimeType = (mimeType: string): boolean =>
  RUN_OUTPUT_ONLY_FILE_TYPE_CONFIG.some((type) => type.mimeType === mimeType);
