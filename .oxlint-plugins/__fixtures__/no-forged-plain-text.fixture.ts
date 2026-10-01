import type { PlainText } from "../../apps/api/src/lib/case-law/plain-text.ts";

declare const sourceText: string;
declare const sourceObject: unknown;
declare const sanitizedText: PlainText;

// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text, typescript/no-unsafe-type-assertion -- fixture: a raw string does not establish sanitizer proof
export const forged = sourceText as PlainText;

type Alias = PlainText;
// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text, typescript/no-unsafe-type-assertion -- fixture: type aliases cannot launder a sanitizer bypass
export const aliased = sourceText as Alias;

// oxlint-disable-next-line typescript/consistent-type-definitions -- fixture: exercise interface-body proof traversal
interface Box {
  value: PlainText;
}
// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text, typescript/no-unsafe-type-assertion -- fixture: interface bodies cannot launder a sanitizer bypass
export const boxed = sourceObject as Box;

// oxlint-disable-next-line typescript/consistent-type-definitions -- fixture: exercise inherited interface proof traversal
interface ExtendedBox extends Box {
  count: number;
}
type ExtendedAlias = ExtendedBox;
// oxlint-disable-next-line no-forged-plain-text/no-forged-plain-text, typescript/no-unsafe-type-assertion -- fixture: inherited proof remains protected through an alias
export const extended = sourceObject as ExtendedAlias;

// expect-clean: no-forged-plain-text/no-forged-plain-text
export const preserved: PlainText = sanitizedText;
