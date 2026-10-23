import { expectTypeOf, test } from "bun:test";

import type { RoutesOf } from "@/api/http/route";
import type { RouteTree } from "@/api/http/route-types";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses = RouteTree<
  RoutesOf<typeof devRoute>
>["dev"]["seed-firm-knowledge"]["post"]["response"];

test("firm-knowledge text errors coexist with auth macro rejection bodies", () => {
  expectTypeOf<FirmKnowledgeForbiddenText>().not.toBeNever();
  expectTypeOf<FirmKnowledgeForbiddenText>().toBeString();
  expectTypeOf<FirmKnowledgeForbiddenMacroError>().not.toBeNever();
  expectTypeOf<FirmKnowledgeForbiddenMacroError["code"]>().toBeString();
  expectTypeOf<FirmKnowledgeForbiddenMacroError["message"]>().toBeString();
  expectTypeOf<FirmKnowledgeConflictText>().not.toBeNever();
  expectTypeOf<FirmKnowledgeConflictText>().toBeString();
});
