import type { properties } from "@/api/db/schema";
import type * as SchemaValidators from "@/api/db/schema-validators";
import type api from "@/api/index.js";
import type * as ViewSchemas from "@/api/lib/views-schema";

export type API = typeof api;

export { toSafeId } from "@/api/lib/branded-types";
export type { SafeId, SafeIdType } from "@/api/lib/branded-types";

export type PropertyTable = typeof properties.$inferSelect;
export type PropertyContent = SchemaValidators.PropertyContent;
export type PropertyContentType = SchemaValidators.PropertyContentType;

export type FieldContent = SchemaValidators.FieldContent;

export type OptionColor = SchemaValidators.OptionColor;

export type BoundingBox = SchemaValidators.BoundingBoxes["boxes"][number];

export type PropertyCondition = SchemaValidators.PropertyCondition;

export type EntityKind = SchemaValidators.EntityKind;

export type {
  ChatMention,
  ChatMentionCategory,
  ChatMentionHref,
  ChatMentionHrefPrefix,
  ChatMentionHrefPrefixMap,
  ChatMessage,
  ChatPart,
  ChatUserFileUrl,
  ChatUITools,
} from "@/api/handlers/chat/types";
export type ViewLayout = ViewSchemas.ViewLayout;
export type ViewLayoutType = ViewSchemas.ViewLayoutType;
export type ViewFilterCondition = ViewSchemas.ViewFilterCondition;
export type { ChatMentionsData } from "@/api/handlers/chat/types";
export type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
export type { UserFileUrl } from "@/api/handlers/user-files/types";
