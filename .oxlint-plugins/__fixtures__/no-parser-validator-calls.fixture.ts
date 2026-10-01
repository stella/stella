// Passive fixture: validator aliases cannot recreate parser-owned validation.
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: aliased named import is still validator access
import { validateAndLog as check } from "./validator-facade";

// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: alias binds to the forbidden validator
check("<p>source</p>", []);

// expect-clean: no-parser-validator-calls/no-parser-validator-calls
export const preserveSourceText = (source: string) => source;
