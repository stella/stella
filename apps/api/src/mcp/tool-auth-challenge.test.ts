import { describe, expect, test } from "bun:test";

import { getMcpWwwAuthenticateHeader } from "@/api/mcp/metadata";
import { withToolAuthChallenge } from "@/api/mcp/tool-auth-challenge";

const errorResult = (code: string) => ({
  content: [
    { type: "text" as const, text: JSON.stringify({ error: { code } }) },
  ],
  isError: true,
});

describe("tool auth challenge", () => {
  test("challenges a missing scope against the surface's metadata", () => {
    for (const mode of ["default", "law"] as const) {
      const challenged = withToolAuthChallenge(
        errorResult("missing_scope"),
        mode,
      );
      const challenge = getMcpWwwAuthenticateHeader({
        error: "insufficient_scope",
        mode,
      });
      expect(challenged._meta).toEqual({
        "mcp/www_authenticate": [challenge],
      });
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain("error_description=");
      expect(challenge).toContain("resource_metadata=");
    }
  });

  test("keeps existing result metadata", () => {
    expect(
      withToolAuthChallenge(
        { ...errorResult("missing_scope"), _meta: { "stella/x": 1 } },
        "default",
      )._meta,
    ).toEqual({
      "stella/x": 1,
      "mcp/www_authenticate": [
        getMcpWwwAuthenticateHeader({ error: "insufficient_scope" }),
      ],
    });
  });

  test("passes every other result through unchanged", () => {
    const results = [
      errorResult("unknown_tool"),
      { content: [{ type: "text" as const, text: "not json" }], isError: true },
      {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: { code: "missing_scope" } }),
          },
        ],
      },
    ];
    for (const result of results) {
      expect(withToolAuthChallenge(result, "default")).toBe(result);
    }
  });
});
