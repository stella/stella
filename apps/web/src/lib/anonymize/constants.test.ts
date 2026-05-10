import { expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS as WASM_DEFAULT_ENTITY_LABELS } from "@stll/anonymize-wasm";

import { DEFAULT_ENTITY_LABELS } from "@/lib/anonymize/constants";

test("web entity label constants stay aligned with anonymize-wasm", () => {
  expect([...DEFAULT_ENTITY_LABELS]).toEqual([...WASM_DEFAULT_ENTITY_LABELS]);
});
