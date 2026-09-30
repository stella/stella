// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: oracle namespace import is runtime access
import * as oracle from "@/api/lib/legal-search/parsers/validate-ast";
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: runtime helper import crosses the oracle boundary
import { buildValidationHtml } from "@/api/lib/legal-search/parsers/validate-ast";
// expect-clean: no-parser-validator-calls/no-parser-validator-calls
import type { ValidationResult } from "@/api/lib/legal-search/parsers/validate-ast.ts";

// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: re-export permits a parser facade to expose the oracle
export { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: dynamic imports also access the oracle
const imported = import("@/api/lib/legal-search/parsers/validate-ast");

export { buildValidationHtml, imported, oracle };
export type { ValidationResult };
