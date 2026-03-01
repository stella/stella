import { t } from "elysia";

/**
 * ^        - Start of string anchor
 * [\w-]    - Character class matching:
 *            \w = word characters (a-z, A-Z, 0-9, _)
 *            -  = hyphen
 * +        - One or more of the preceding characters
 * $        - End of string anchor
 * u (flag) - Enable full Unicode support
 */
const NANO_ID_REGEX: RegExp = /^[\w-]+$/u;

export const tNanoid = t.String({
  minLength: 21,
  maxLength: 21,
  pattern: NANO_ID_REGEX.source,
});

export const tDefaultVarchar = t.String({
  minLength: 1,
  maxLength: 256,
});
