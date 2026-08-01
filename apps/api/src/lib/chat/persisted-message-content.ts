import { panic } from "better-result";

export type PersistedChatMessageContentCandidate<TPart, TMetadata> = {
  data: TPart[];
  metadata?: TMetadata | undefined;
  version: 2;
};

export declare const persistedChatMessageContentProof: unique symbol;
export type PersistedChatMessageContentProof = {
  readonly [persistedChatMessageContentProof]: true;
};
export type ProvenPersistedChatMessageContent<TContent> = TContent &
  PersistedChatMessageContentProof;

const hasOnlyProvenParts = <TPart, TMetadata>(
  content: PersistedChatMessageContentCandidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): content is ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<TPart, TMetadata>
> => content.data.every(isPersistablePart);

export const provePersistedChatMessageContent = <TPart, TMetadata>(
  content: PersistedChatMessageContentCandidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<TPart, TMetadata>
> => {
  if (!hasOnlyProvenParts(content, isPersistablePart)) {
    panic("Cannot persist chat message content with unsupported parts");
  }
  return content;
};

type PersistedTextChatPart = { content: string; type: "text" };

const isPersistedTextChatPart = (
  part: unknown,
): part is PersistedTextChatPart =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  part.type === "text" &&
  "content" in part &&
  typeof part.content === "string";

export const proveTextOnlyPersistedChatMessageContent = <TMetadata>(
  content: PersistedChatMessageContentCandidate<
    PersistedTextChatPart,
    TMetadata
  >,
): ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<PersistedTextChatPart, TMetadata>
> => provePersistedChatMessageContent(content, isPersistedTextChatPart);
