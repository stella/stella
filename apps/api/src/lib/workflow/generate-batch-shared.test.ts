import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { prepareBatchInput } from "@/api/lib/workflow/generate-batch-shared";
import type { PropertyBatch } from "@/api/lib/workflow/get-execution-plan";

const priceId = toSafeId<"property">("prop-price");
const ownerId = toSafeId<"property">("prop-owner");
const summaryId = toSafeId<"property">("prop-summary");

const batch: PropertyBatch = {
  id: "batch",
  inputs: [priceId, ownerId],
  properties: [
    {
      id: summaryId,
      status: "stale",
      content: { version: 1, type: "text" },
      dependencies: [
        { dependsOnPropertyId: priceId, condition: null },
        { dependsOnPropertyId: ownerId, condition: null },
      ],
      tool: { version: 1, type: "ai-model", prompt: "Summarize the offer." },
    },
  ],
};

describe("prepareBatchInput", () => {
  test("money and person inputs reach the model as text", () => {
    const prepared = prepareBatchInput(
      [
        {
          id: toSafeId<"field">("field-price"),
          propertyId: priceId,
          content: {
            version: 1,
            type: "money",
            amountCents: 125_000_050,
            currency: "CZK",
          },
        },
        {
          id: toSafeId<"field">("field-owner"),
          propertyId: ownerId,
          content: {
            version: 1,
            type: "person",
            userId: null,
            name: "Responsible lawyer",
            image: null,
          },
        },
      ],
      batch,
    );

    expect(Result.isOk(prepared) && prepared.value.textInputs).toEqual([
      { propertyId: priceId, value: "1250000.50 CZK" },
      { propertyId: ownerId, value: "Responsible lawyer" },
    ]);
  });
});
