import { describe, expect, test } from "bun:test";

import { skillPromptResourceUri } from "@/api/mcp/gateway/skill-prompt-resource-uri";

describe("skill prompt resource URIs", () => {
  test("percent-encode each path segment and keep the separators", () => {
    expect(
      skillPromptResourceUri({
        name: "contract-review",
        path: "references/Smlouva o dílo #2.md",
      }),
    ).toBe(
      "stella://skills/contract-review/references/Smlouva%20o%20d%C3%ADlo%20%232.md",
    );
    expect(
      skillPromptResourceUri({ name: "plain", path: "scripts/run.ts" }),
    ).toBe("stella://skills/plain/scripts/run.ts");
  });
});
