// Passive regression fixture for `retention-oracle-owner/retention-oracle-owner`:
// only the pipeline's retention check logs the text-retention signal, while
// the pure measurement stays importable for parsers choosing between parses.

// expect-clean: retention-oracle-owner/retention-oracle-owner
import {
  buildValidationHtml,
  type ValidationSource,
  // oxlint-disable-next-line retention-oracle-owner/retention-oracle-owner -- logging oracle outside its owner
  validateAndLog,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";

export const fixtureSource: ValidationSource = buildValidationHtml(["text"]);
export const fixtureVerdict = validateAst(fixtureSource, []).ok;
export { validateAndLog };
