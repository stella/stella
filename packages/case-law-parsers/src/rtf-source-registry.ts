// parser-output-unchanged: moved to @stll/case-law-parsers with identical "cz-us" code page default.
import type { ReadRtfOptions } from "./rtf-reader";

/** Publisher defaults apply only when the RTF document states no code page. */
export const RTF_SOURCE_OPTIONS = {
  "cz-us": { defaultCodePage: 1250 },
} as const satisfies Record<"cz-us", ReadRtfOptions>;
