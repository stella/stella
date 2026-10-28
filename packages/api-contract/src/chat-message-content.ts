import * as v from "valibot";

/**
 * A chat user message must give the model something to read. Every client
 * and the send endpoint apply this one rule, so a message that would reach a
 * provider empty is refused before it is sent or stored.
 *
 * A part carries model content when it is a text part with a non-whitespace
 * character, or a part of any other modality (an image, a document, audio,
 * video). Text is judged as the model reads it: the send endpoint applies the
 * rule after it has turned composer HTML into the stored text, and a client
 * applies it to the text its HTML renders.
 */
const chatMessageContentPartSchema = v.looseObject({
  type: v.string(),
  content: v.exactOptional(v.unknown()),
});

export type ChatMessageContentPart = v.InferOutput<
  typeof chatMessageContentPartSchema
>;

const NON_WHITESPACE = /\S/u;

export const chatPartCarriesModelContent = (
  part: ChatMessageContentPart,
): boolean =>
  part.type !== "text" ||
  (typeof part.content === "string" && NON_WHITESPACE.test(part.content));

export const chatUserMessageContentSchema = v.pipe(
  v.array(chatMessageContentPartSchema),
  v.check(
    (parts) => parts.some(chatPartCarriesModelContent),
    "A chat message needs text or an attachment",
  ),
);

export const hasChatModelContent = (
  parts: readonly ChatMessageContentPart[],
): boolean => v.is(chatUserMessageContentSchema, parts);
