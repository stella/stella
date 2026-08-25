import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "./desktop-edit-file-types";

export const CHAT_FILE_TYPE_CONFIG = [
  { extensions: [".png"], mimeType: "image/png" },
  { extensions: [".jpg", ".jpeg"], mimeType: "image/jpeg" },
  { extensions: [".webp"], mimeType: "image/webp" },
  { extensions: [".gif"], mimeType: "image/gif" },
  { extensions: [".pdf"], mimeType: "application/pdf" },
  {
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.extension],
    mimeType: DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType,
  },
  {
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.extension],
    mimeType: DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType,
  },
  { extensions: [".txt"], mimeType: "text/plain" },
  { extensions: [".csv"], mimeType: "text/csv" },
  { extensions: [".md"], mimeType: "text/markdown" },
] as const;

export const CHAT_FILE_MIME_TYPES = CHAT_FILE_TYPE_CONFIG.map(
  ({ mimeType }) => mimeType,
);

export type ChatFileMimeType = (typeof CHAT_FILE_MIME_TYPES)[number];

export const isChatFileMimeType = (value: string): value is ChatFileMimeType =>
  CHAT_FILE_MIME_TYPES.some((mimeType) => mimeType === value);

export const CHAT_FILE_INPUT_ACCEPT = CHAT_FILE_TYPE_CONFIG.flatMap(
  ({ extensions }) => extensions,
).join(",");
