import { sha256Base64Url } from "@stll/sha256/bun";

type TextCursorPayload = {
  offset: number;
  subject: string;
};

const CURSOR_PREFIX = "ptw1";

// Keep damaged members of this codec's class for the decoder to refuse;
// treating them as placeholders would silently restart a continuation.
export const isProvisionTextCursor = (value: string): boolean =>
  value === CURSOR_PREFIX || value.startsWith(`${CURSOR_PREFIX}.`);

const checksum = (payload: string): string => sha256Base64Url(payload);

const encodePayload = ({ offset, subject }: TextCursorPayload): string => {
  const encoded = `${offset}.${checksum(subject)}`;
  return `${CURSOR_PREFIX}.${encoded}.${checksum(encoded)}`;
};

const decodePayload = (cursor: string): TextCursorPayload | null => {
  const [prefix, offsetText, subjectText, digest, extra] = cursor.split(".");
  if (
    prefix !== CURSOR_PREFIX ||
    offsetText === undefined ||
    subjectText === undefined ||
    digest === undefined ||
    extra !== undefined
  ) {
    return null;
  }
  const encoded = `${offsetText}.${subjectText}`;
  if (checksum(encoded) !== digest) {
    return null;
  }

  const offset = Number(offsetText);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return null;
  }
  return {
    offset,
    subject: subjectText,
  };
};

export type ProvisionTextWindow =
  | { type: "invalid-cursor" }
  | {
      type: "window";
      text: string;
      truncated: boolean;
      nextTextCursor: string | null;
    };

/** Returns a bounded window without splitting a UTF-16 surrogate pair. */
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
      decoded.subject !== checksum(subject) ||
      decoded.offset > text.length)
  ) {
    return { type: "invalid-cursor" };
  }

  const offset = decoded?.offset ?? 0;
  let end = Math.min(offset + limit, text.length);
  if (
    end < text.length &&
    end > offset &&
    /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))
  ) {
    end -= 1;
  }
  const nextTextCursor =
    end < text.length ? encodePayload({ offset: end, subject }) : null;
  return {
    type: "window",
    text: text.slice(offset, end),
    truncated: nextTextCursor !== null,
    nextTextCursor,
  };
};
