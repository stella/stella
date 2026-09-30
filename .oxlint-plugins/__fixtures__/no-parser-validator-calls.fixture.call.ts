// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: unknown computed properties on an oracle import cannot evade call budgets
import * as importedOracle from "@/api/lib/legal-search/parsers/validate-ast";

declare const validateAndLog: (source: string, blocks: unknown[]) => void;
declare const validateAst: (source: string, blocks: unknown[]) => void;
declare const oracle: { validateAst: typeof validateAst };

// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: a validator call without a local import is still forbidden
validateAndLog("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: direct oracle invocation cannot be parser-owned
validateAst("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: namespace validator invocation is still direct oracle access
oracle.validateAst("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls, typescript/dot-notation -- fixture: computed static member invocation must exercise bracket access
oracle["validateAst"]("<p>source</p>", []);

// expect-clean: no-parser-validator-calls/no-parser-validator-calls
export const renderText = (source: string) => source;

// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: constant template literals name the same validator
oracle[`validateAst`]("<p>source</p>", []);
const validatorProperty = "validateAst";
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: a constant string binding selects the validator
oracle[validatorProperty]("<p>source</p>", []);
export const callUnknownProperty = (property: string) => {
  // oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: unresolved oracle properties are conservatively charged
  importedOracle[property]("<p>source</p>", []);
};
{
  // oxlint-disable-next-line no-shadow -- fixture: computed identifiers resolve the shadowed binding value
  const validateAst = "buildValidationHtml";
  // expect-clean: no-parser-validator-calls/no-parser-validator-calls
  importedOracle[validateAst]("<p>source</p>", []);
}
