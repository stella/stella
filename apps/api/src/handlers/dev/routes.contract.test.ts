import { expectTypeOf, test } from "bun:test";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses =
  (typeof devRoute)["~Routes"]["dev"]["seed-firm-knowledge"]["post"]["response"];

test("firm-knowledge membership and job conflicts are typed HTTP errors", () => {
  expectTypeOf<FirmKnowledgeResponses>().toExtend<{
    403: string;
    409: string;
  }>();
});
