/**
 * Branded types for prompt-injection defence.
 *
 * Text crossing into an LLM prompt from outside the binary (uploaded
 * documents, user paste, external API responses, other tenants' data)
 * is structurally distinct from developer-authored prompt scaffolding.
 *
 * - `UntrustedText` marks the boundary at which raw input enters.
 * - `PromptSafeText` is only mintable via `sanitizeForPrompt`, which
 *   strips role markers and wraps the content in delimiters that the
 *   surrounding template can refer to as data, not instructions.
 *
 * This is defence in depth, not a guarantee — pair with least-privilege
 * tool use, output filtering, and tenant partitioning. What the brand
 * does guarantee: a contributor cannot accidentally interpolate raw
 * input into a prompt position without going through a function
 * named `sanitizeForPrompt`, visible in code review.
 */

declare const __promptBrand: unique symbol;

export type UntrustedText = string & {
  readonly [__promptBrand]: "UntrustedText";
};

export type PromptSafeText = string & {
  readonly [__promptBrand]: "PromptSafeText";
};

/**
 * Declares that a string crossed an untrusted boundary. Call this at
 * the entry point (handler reading a document, fetching an external
 * page, accepting user-pasted content), not deep in the call graph.
 */
export const untrustedText = (text: string): UntrustedText =>
  // SAFETY: nominal brand; promotion to PromptSafeText happens in sanitizeForPrompt
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  text as UntrustedText;

type SanitizeForPromptOptions = {
  maxLength?: number;
  /**
   * Delimiter pair wrapped around the sanitized output so the prompt
   * template can instruct the model to treat content between the
   * markers as data, not instructions. Defaults are deliberately
   * distinctive and unlikely to appear in real input.
   */
  open?: string;
  close?: string;
};

const DEFAULT_OPEN = "<<<UNTRUSTED>>>";
const DEFAULT_CLOSE = "<<<END_UNTRUSTED>>>";

const ROLE_MARKERS: readonly RegExp[] = [
  /<\|[^|]{0,128}\|>/gu,
  /\[\/?INST\]/giu,
  /<<\/?SYS>>/gu,
  /^[ \t]*(?:system|assistant|user|tool|developer)[ \t]*:/gimu,
];

const INVISIBLE_OVERRIDES =
  /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;

const isStrippableControl = (code: number): boolean =>
  code <= 0x08 ||
  code === 0x0b ||
  code === 0x0c ||
  (code >= 0x0e && code <= 0x1f) ||
  code === 0x7f;

const stripControlChars = (input: string): string => {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === undefined || !isStrippableControl(code)) {
      out += ch;
    }
  }
  return out;
};

const TRUNCATION_SUFFIX = "…[truncated]";

/**
 * Promote untrusted input to text safe for prompt interpolation.
 *
 * Stripped: ASCII control chars, Unicode bidi/zero-width overrides
 * (used in published injection PoCs), ChatML / Llama / generic
 * role-prefix lines, and the delimiter sequences themselves (so
 * input cannot pre-close the wrapper).
 */
export const sanitizeForPrompt = (
  text: UntrustedText,
  options?: SanitizeForPromptOptions,
): PromptSafeText => {
  const open = options?.open ?? DEFAULT_OPEN;
  const close = options?.close ?? DEFAULT_CLOSE;

  let cleaned: string = stripControlChars(text);
  cleaned = cleaned.replace(INVISIBLE_OVERRIDES, "");
  for (const pattern of ROLE_MARKERS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.split(open).join("").split(close).join("");

  if (options?.maxLength !== undefined && cleaned.length > options.maxLength) {
    cleaned = `${cleaned.slice(0, options.maxLength)}${TRUNCATION_SUFFIX}`;
  }

  // SAFETY: all known control sequences, role markers, and delimiter
  // collisions removed above; wrapper guarantees the model sees data
  // boundaries even if the surrounding template forgets to add them.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return `${open}\n${cleaned}\n${close}` as PromptSafeText;
};
