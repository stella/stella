import { expectTypeOf, test } from "bun:test";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses =
  (typeof devRoute)["~Routes"]["dev"]["seed-firm-knowledge"]["post"]["response"];
type FirmKnowledgeErrorResponses = Pick<FirmKnowledgeResponses, 403 | 409>;
type FirmKnowledgeForbiddenText = Extract<
  FirmKnowledgeErrorResponses[403],
  string
>;
type FirmKnowledgeForbiddenMacroError = Extract<
  FirmKnowledgeErrorResponses[403],
  { code: string; message: string }
>;
type FirmKnowledgeConflictText = Extract<
  FirmKnowledgeErrorResponses[409],
  string
>;

test("firm-knowledge text errors coexist with auth macro rejection bodies", () => {
  expectTypeOf<FirmKnowledgeForbiddenText>().not.toBeNever();
  expectTypeOf<FirmKnowledgeForbiddenText>().toBeString();
  expectTypeOf<FirmKnowledgeForbiddenMacroError>().not.toBeNever();
  expectTypeOf<FirmKnowledgeForbiddenMacroError["code"]>().toBeString();
  expectTypeOf<FirmKnowledgeForbiddenMacroError["message"]>().toBeString();
  expectTypeOf<FirmKnowledgeConflictText>().not.toBeNever();
  expectTypeOf<FirmKnowledgeConflictText>().toBeString();
});
