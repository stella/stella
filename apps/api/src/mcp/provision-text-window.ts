import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { sha256Base64Url } from "@stll/sha256/bun";

type TextCursorPayload = {
  offset: number;
  binding: string;
};

const CURSOR_PREFIX = "ptw1";

// Keep damaged members of this codec's class for the decoder to refuse;
// treating them as placeholders would silently restart a continuation.
export const isProvisionTextCursor = (value: string): boolean =>
  value === CURSOR_PREFIX || value.startsWith(`${CURSOR_PREFIX}.`);

const checksum = (payload: string): string => sha256Base64Url(payload);

// A cursor continues one exact text: a corrected consolidation under the same
// subject must not be stitched onto windows read from the previous wording.
const textBinding = (subject: string, text: string): string =>
  checksum(`${subject}\u0000${checksum(text)}`);

const encodePayload = ({ offset, binding }: TextCursorPayload): string => {
  const encoded = `${offset}.${binding}`;
  return `${CURSOR_PREFIX}.${encoded}.${checksum(encoded)}`;
};

const decodePayload = (cursor: string): TextCursorPayload | null => {
  const [prefix, offsetText, bindingText, digest, extra] = cursor.split(".");
  if (
    prefix !== CURSOR_PREFIX ||
    offsetText === undefined ||
    bindingText === undefined ||
    digest === undefined ||
    extra !== undefined
  ) {
    return null;
  }
  const encoded = `${offsetText}.${bindingText}`;
  if (checksum(encoded) !== digest) {
    return null;
  }

  const offset = parseIntegerToken(offsetText, { sign: "unsigned" }).unwrapOr(
    null,
  );
  if (offset === null) {
    return null;
  }
  return {
    offset,
    binding: bindingText,
  };
};

const splitsSurrogatePair = (text: string, offset: number) =>
  /[\uD800-\uDBFF]/u.test(text.charAt(offset - 1)) &&
  /[\uDC00-\uDFFF]/u.test(text.charAt(offset));

export type ProvisionTextWindow =
  | { type: "invalid-cursor" }
  | {
      type: "window";
      text: string;
      truncated: boolean;
      nextTextCursor: string | null;
    };

/** Retains whole code points; a one-unit budget may return a surrogate pair. */
export const windowProvisionText = ({
  cursor,
  limit,
  subject,
  text,
}: {
  cursor?: string | undefined;
  limit: number;
  subject: string;
  text: string;
}): ProvisionTextWindow => {
  const decoded = cursor === undefined ? null : decodePayload(cursor);
  if (
    cursor !== undefined &&
    (decoded === null ||
      decoded.binding !== textBinding(subject, text) ||
      decoded.offset > text.length ||
      splitsSurrogatePair(text, decoded.offset))
  ) {
    return { type: "invalid-cursor" };
  }

  const offset = decoded?.offset ?? 0;
  let end = Math.min(offset + limit, text.length);
  if (end < text.length && end > offset && splitsSurrogatePair(text, end)) {
    // Include the first code point rather than emitting an empty continuation.
    end = end === offset + 1 ? end + 1 : end - 1;
  }
  const nextTextCursor =
    end < text.length
      ? encodePayload({ offset: end, binding: textBinding(subject, text) })
      : null;
  return {
    type: "window",
    text: text.slice(offset, end),
    truncated: nextTextCursor !== null,
    nextTextCursor,
  };
};
