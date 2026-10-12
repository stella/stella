import { expect, test } from "bun:test";

import { decisionModelResponse } from "@/api/lib/ai-config-response";

test("decision configuration read-back preserves region and credential ownership", () => {
  expect(decisionModelResponse(null)).toBeNull();
  const reuse = decisionModelResponse({
    provider: "openai",
    region: "eu",
    modelId: "gpt-6-luna",
  });
  const serializedReuse = JSON.stringify(reuse);
  expect(JSON.parse(serializedReuse)).toEqual({
    provider: "openai",
    region: "eu",
    modelId: "gpt-6-luna",
  });
  const separate = decisionModelResponse({
    provider: "openai",
    region: "global",
    modelId: "gpt-6-luna",
    apiKey: "fixture-openai-separate-key",
  });
  expect(separate).toMatchObject({
    provider: "openai",
    region: "global",
    modelId: "gpt-6-luna",
    apiKeyMasked: expect.any(String),
  });
  expect(JSON.stringify(separate)).not.toContain("fixture-openai-separate-key");
  const typesafe = decisionModelResponse({
    provider: "typesafe",
    modelId: "jev-latest",
    apiKey: "fixture-typesafe-separate-key",
  });
  expect(typesafe).toMatchObject({
    provider: "typesafe",
    modelId: "jev-latest",
    apiKeyMasked: expect.any(String),
  });
  expect(JSON.stringify(typesafe)).not.toContain(
    "fixture-typesafe-separate-key",
  );
  expect(typesafe).not.toHaveProperty("region");
});
