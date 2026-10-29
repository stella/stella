import { parseSkUsDocumentXhtml as rawParse } from "../../apps/api/src/handlers/case-law/ingestion/parsers/sk-us";
import { guardParser } from "../../apps/api/src/tests/helpers/parser-reader-guard";

// expect-clean: parser-fixture-reader-guard/parser-fixture-reader-guard
const parse = guardParser(rawParse);

export const fixtureGuard = (input: Parameters<typeof parse>[0]) => {
  // oxlint-disable-next-line parser-fixture-reader-guard/parser-fixture-reader-guard -- fixture: direct parser calls bypass persisted validation
  rawParse(input);
  return parse(input);
};
