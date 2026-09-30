// The production rule is scoped to parsers/adapters, leaving the pipeline
// free to validate each decision. Scope coverage asserts this same boundary.
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";
// expect-clean: no-parser-validator-calls/no-parser-validator-calls
validateAndLog("<p>raw source</p>", []);
