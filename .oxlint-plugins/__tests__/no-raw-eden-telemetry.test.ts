import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("tracks Eden provenance without matching arbitrary errors", async () => {
  expect(
    await lintSingleRule(
      "no-raw-eden-telemetry",
      `
import { api as client } from "@/lib/api";
const response = await client.items.get();
analytics.captureError(response.error);
const { error: failure } = response;
const alias = failure;
analytics.captureException(alias);
analytics.captureError(toAPIError(failure));
analytics.captureError(unwrapEden(response));
const other = await unrelated.get();
analytics.captureError(other.error);
function caught(error) { analytics.captureError(error); }
function shadow(client) { const result = client.items.get(); analytics.captureError(result.error); }
const { error } = await client.items({ id: "item" }).delete();
analytics.captureError(error);
analytics.captureException((await client.items.get()).error);
`,
    ),
  ).toEqual([4, 7, 15, 16]);
});
