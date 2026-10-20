import { expectTypeOf, test } from "bun:test";

import type { RoutesOf } from "@/api/lib/elysia-contract";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses = RoutesOf<
  typeof devRoute
>["dev"]["seed-firm-knowledge"]["post"]["response"];

test("firm-knowledge membership and job conflicts are typed HTTP errors", () => {
  expectTypeOf<FirmKnowledgeResponses>().toExtend<{
    403: string;
    409: string;
  }>();
});
