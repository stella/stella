import * as v from "valibot";

export const CHAT_MESSAGE_EDIT_TYPE = {
  aiSpan: "ai_span",
  format: "format",
  revert: "revert",
} as const;

export const CHAT_MESSAGE_EDIT_FORMAT = {
  bold: "bold",
  italic: "italic",
  link: "link",
  style: "style",
} as const;
export const CHAT_MESSAGE_EDIT_KEY_SOURCES = ["byok", "instance"] as const;
export const CHAT_MESSAGE_EDIT_STYLES = [
  "paragraph",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "ordered-list",
  "unordered-list",
] as const;

export const CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH = 4000;
export const CHAT_MESSAGE_EDIT_MODEL_MAX_LENGTH = 255;
export const CHAT_MESSAGE_EDIT_URL_MAX_LENGTH = 2048;

const offsetSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const spanEntries = { start: offsetSchema, end: offsetSchema };
const formatEditSchema = v.union([
  v.strictObject({
    type: v.picklist([CHAT_MESSAGE_EDIT_TYPE.format]),
    ...spanEntries,
    format: v.picklist([
      CHAT_MESSAGE_EDIT_FORMAT.bold,
      CHAT_MESSAGE_EDIT_FORMAT.italic,
    ]),
  }),
  v.strictObject({
    type: v.picklist([CHAT_MESSAGE_EDIT_TYPE.format]),
    ...spanEntries,
    format: v.picklist([CHAT_MESSAGE_EDIT_FORMAT.link]),
    url: v.pipe(
      v.string(),
      v.maxLength(CHAT_MESSAGE_EDIT_URL_MAX_LENGTH),
      v.url(),
      v.regex(/^https?:\/\//u),
    ),
  }),
  v.strictObject({
    type: v.picklist([CHAT_MESSAGE_EDIT_TYPE.format]),
    ...spanEntries,
    format: v.picklist([CHAT_MESSAGE_EDIT_FORMAT.style]),
    style: v.picklist(CHAT_MESSAGE_EDIT_STYLES),
  }),
]);

/** Accepted edits describe the source span in the replaced content snapshot. */
export const chatMessageAcceptedEditSchema = v.union([
  v.strictObject({
    type: v.picklist([CHAT_MESSAGE_EDIT_TYPE.aiSpan]),
    ...spanEntries,
    instruction: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH),
    ),
    model: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(CHAT_MESSAGE_EDIT_MODEL_MAX_LENGTH),
    ),
    keySource: v.picklist(CHAT_MESSAGE_EDIT_KEY_SOURCES),
  }),
  formatEditSchema,
]);

export type ChatMessageAcceptedEdit = v.InferOutput<
  typeof chatMessageAcceptedEditSchema
>;

export const chatMessageRevisionEditSchema = v.union([
  chatMessageAcceptedEditSchema,
  v.strictObject({
    type: v.picklist([CHAT_MESSAGE_EDIT_TYPE.revert]),
    toRevision: offsetSchema,
  }),
]);

export type ChatMessageRevisionEdit = v.InferOutput<
  typeof chatMessageRevisionEditSchema
>;

export const CHAT_ANSWER_EDIT_STATES = [
  "instruction",
  "requesting",
  "proposal",
  "accepting",
  "stale",
] as const;
