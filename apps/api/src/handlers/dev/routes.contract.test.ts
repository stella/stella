import { expectTypeOf, test } from "bun:test";

import type { devRoute } from "./routes";

type FirmKnowledgeResponses =
  (typeof devRoute)["~Routes"]["dev"]["seed-firm-knowledge"]["post"]["response"];

test("firm-knowledge membership and job conflicts are typed HTTP errors", () => {
  expectTypeOf<
    Extract<FirmKnowledgeResponses[403], string>
  >().toExtend<string>();
  expectTypeOf<FirmKnowledgeResponses[409]>().toExtend<string>();
});
