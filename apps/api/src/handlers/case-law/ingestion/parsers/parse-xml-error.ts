// parser-output-unchanged: [at-courts] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-vfgh] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-vwgh] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-bvwg] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-lvwg] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-asylgh] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-ubas] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-uvs] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-verg] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-umse] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-bks] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [at-findok] ParseXmlError moved here unchanged; successful parser output is identical.
// parser-output-unchanged: [pl-uodo] ParseXmlError moved here unchanged; successful parser output is identical.
import { TaggedError } from "better-result";

export class ParseXmlError extends TaggedError("ParseXmlError")<{
  message: string;
  cause: unknown;
}> {}
