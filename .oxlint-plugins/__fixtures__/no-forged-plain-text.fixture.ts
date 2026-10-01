import type { PlainText } from "../../apps/api/src/lib/case-law/plain-text.ts";

declare const sourceText: string;
declare const sanitizedText: PlainText;

// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text -- fixture: a raw string does not establish sanitizer proof
export const forged = sourceText as PlainText;

type Alias = PlainText;
// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text -- fixture: type aliases cannot launder a sanitizer bypass
export const aliased = sourceText as Alias;

// expect-clean: no-forged-plain-text/no-forged-plain-text
export const preserved: PlainText = sanitizedText;
