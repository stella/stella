import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  flowDefinitionBodySchema,
  updateFlowDefinitionBodySchema,
} from "./schema";

const definition = {
  name: "Review documents",
  description: null,
  steps: [
    {
      kind: "review-gate",
      name: "Review",
      instructions: "Check the document.",
    },
  ],
  trigger: { type: "manual" },
  enabled: true,
} satisfies v.InferInput<typeof flowDefinitionBodySchema>;

test("creation stays token-free while replacement requires a valid editor token", () => {
  expect(v.safeParse(flowDefinitionBodySchema, definition).success).toBe(true);
  expect(v.safeParse(updateFlowDefinitionBodySchema, definition).success).toBe(
    false,
  );
  expect(
    v.safeParse(updateFlowDefinitionBodySchema, {
      ...definition,
      expectedUpdatedAt: "not-a-date",
    }).success,
  ).toBe(false);
  const token = "2099-01-01T00:00:00.000Z";
  expect(
    v.parse(updateFlowDefinitionBodySchema, {
      ...definition,
      expectedUpdatedAt: token,
    }),
  ).toEqual({ ...definition, expectedUpdatedAt: token });
});
