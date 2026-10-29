// parser-output-unchanged: [at-asylgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-bks] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-bvwg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-courts] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-findok] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-lvwg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-ubas] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-umse] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-uvs] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-verg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-vfgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-vwgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-ns] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-nss] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-regional] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-us] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [hu-bhgy] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-kis] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-nsa] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-uokik] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [sk-courts] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [sk-us] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [uk-fcl] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [us-courtlistener] registered replay fixture fields are unchanged by numeric index normalization.
import { normalizeUnicode } from "./unicode.js";

const NUMERIC_SUPERSCRIPT_INDEX = /(?<=\d)[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu;

/**
 * Keep a numeric superscript attached to a number distinct from its digits.
 * Run before compatibility folding: NFKC alone turns `505⁹` into `5059`.
 * Caret and parenthesized indices already have an ordinary token boundary.
 */
export const normalizeNumericIndices = (text: string): string =>
  text.replace(
    NUMERIC_SUPERSCRIPT_INDEX,
    (index) => `^${normalizeUnicode(index, "NFKC")}`,
  );
