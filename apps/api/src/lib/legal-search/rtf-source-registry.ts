import { ADAPTER_KEYS } from "./ingestion-constants";
import type { ReadRtfOptions } from "./parsers/rtf-reader";

/** Publisher defaults apply only when the RTF document states no code page. */
export const RTF_SOURCE_OPTIONS = {
  [ADAPTER_KEYS.CZ_US]: { defaultCodePage: 1250 },
} as const satisfies Record<typeof ADAPTER_KEYS.CZ_US, ReadRtfOptions>;
