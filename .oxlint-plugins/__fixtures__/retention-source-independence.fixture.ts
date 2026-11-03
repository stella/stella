// Passive regression fixture for
// `retention-source-independence/retention-source-independence`: a retention
// projection reaching parser code, an adapter or an AST builder is reported.

// expect-clean: retention-source-independence/retention-source-independence
import { Result } from "better-result";

// oxlint-disable-next-line retention-source-independence/retention-source-independence -- parser module
import { parseCzNss } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import type { ValidationSource } from "@/api/lib/legal-search/parsers/validate-ast";

export const fixtureSource = (raw: string): Result<ValidationSource, never> =>
  Result.ok(raw);
export { parseCzNss };
