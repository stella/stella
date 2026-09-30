// Passive detection fixtures; each suppression must be used exactly once.
import {
  // oxlint-disable-next-line no-parser-text-validation/no-parser-text-validation -- fixture: aliased parser validation import is forbidden
  validateAndLog as validate,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";
// oxlint-disable-next-line no-parser-text-validation/no-parser-text-validation -- fixture: namespace imports cannot launder validation
import * as validator from "@/api/lib/legal-search/parsers/validate-ast";

declare const validateAndLog: () => void;
// oxlint-disable-next-line no-parser-text-validation/no-parser-text-validation -- fixture: parser-local validation calls are forbidden
validateAndLog();
// oxlint-disable-next-line no-parser-text-validation/no-parser-text-validation -- fixture: imported aliases remain forbidden at the callsite
const _alias = validate({ parser: "fixture", caseNumber: "fixture" }, "", []);
// oxlint-disable-next-line no-parser-text-validation/no-parser-text-validation -- fixture: namespace calls remain forbidden
const _namespace = validator.validateAndLog(
  { parser: "fixture", caseNumber: "fixture" },
  "",
  [],
);
// expect-clean: no-parser-text-validation/no-parser-text-validation
const _normalization = validateAst("Allowed intermediate comparison", []);
export const __noParserTextValidationFixture = {
  _alias,
  _namespace,
  _normalization,
};
