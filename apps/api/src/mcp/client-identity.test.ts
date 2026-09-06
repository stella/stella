import { describe, expect, test } from "bun:test";

import { sanitizeMcpClientIdentity } from "@/api/mcp/client-identity";

describe("sanitizeMcpClientIdentity", () => {
  test("keeps a well-formed identity", () => {
    expect(
      sanitizeMcpClientIdentity({ name: "claude-ai", version: "1.4.2" }),
    ).toEqual({ clientName: "claude-ai", clientVersion: "1.4.2" });
  });

  test("caps each reported field at 128 characters", () => {
    const identity = sanitizeMcpClientIdentity({
      name: "n".repeat(400),
      version: "1.".repeat(400),
    });

    expect(identity.clientName).toHaveLength(128);
    expect(identity.clientVersion).toHaveLength(128);
  });

  test("drops non-string fields instead of reporting them", () => {
    expect(
      sanitizeMcpClientIdentity({
        name: { toString: () => "injected" },
        version: 42,
      }),
    ).toEqual({ clientName: "unspecified" });
    expect(sanitizeMcpClientIdentity("claude-ai")).toEqual({
      clientName: "unspecified",
    });
    expect(sanitizeMcpClientIdentity(undefined)).toEqual({
      clientName: "unspecified",
    });
  });

  test("leaves an unreported version out rather than inventing one", () => {
    expect(sanitizeMcpClientIdentity({ name: "claude-ai" })).toEqual({
      clientName: "claude-ai",
    });
  });

  test("treats a blank name as unreported", () => {
    expect(sanitizeMcpClientIdentity({ name: "   ", version: "  " })).toEqual({
      clientName: "unspecified",
    });
  });
});
