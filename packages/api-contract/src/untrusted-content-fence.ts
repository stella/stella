// Delimiters the API wraps around untrusted content placed in a model prompt
// or tool result. Distinctive by design so they do not occur in real input;
// the API strips them from the payload before wrapping it.
export const UNTRUSTED_CONTENT_OPEN = "<<<UNTRUSTED>>>";
export const UNTRUSTED_CONTENT_CLOSE = "<<<END_UNTRUSTED>>>";

/**
 * The payload between the first opening and the last closing delimiter, or
 * `null` when the text carries no complete fence. Readers that parse a fenced
 * tool result (for example as JSON) use this to recover the payload.
 */
export const unwrapUntrustedContentFence = (text: string): string | null => {
  const start = text.indexOf(UNTRUSTED_CONTENT_OPEN);
  const end = text.lastIndexOf(UNTRUSTED_CONTENT_CLOSE);
  if (
    start === -1 ||
    end === -1 ||
    end < start + UNTRUSTED_CONTENT_OPEN.length
  ) {
    return null;
  }
  return text.slice(start + UNTRUSTED_CONTENT_OPEN.length, end);
};
