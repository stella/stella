// This import and call have separate legacy budgets. Removing either must
// remove its ledger row; another call must fail even in an allowlisted file.
// expect-clean: no-parser-validator-calls/no-parser-validator-calls
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";
// expect-clean: no-parser-validator-calls/no-parser-validator-calls
validateAndLog("<p>legacy</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: an allowlisted file cannot add a second validator call
validateAndLog("<p>new caller</p>", []);
