import { expectTypeOf, test } from "bun:test";

import type { RoutesOf } from "@/api/http/route";
import type { RouteTree } from "@/api/http/route-types";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses = RouteTree<
  RoutesOf<typeof devRoute>
>["dev"]["seed-firm-knowledge"]["post"]["response"];

test("firm-knowledge text errors keep their statuses in the route type", () => {
  expectTypeOf<FirmKnowledgeResponses[403]>().not.toBeNever();
  expectTypeOf<FirmKnowledgeResponses[403]>().toBeString();
  expectTypeOf<FirmKnowledgeResponses[409]>().not.toBeNever();
  expectTypeOf<FirmKnowledgeResponses[409]>().toBeString();
});
