import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { resolveEnabledMcpWebSearchProvider } from "@/api/mcp/context";

test("an unreadable stored key leaves the MCP session without web search", async () => {
  const availability = await resolveEnabledMcpWebSearchProvider({
    disabledNativeToolSlugs: [],
    organizationId: toSafeId<"organization">("fixture-org"),
    row: {
      webSearchApiKeyEncrypted: Buffer.from("not-encrypted"),
      webSearchApiKeyIv: Buffer.from("not-an-iv"),
      urlFetchApiKeyEncrypted: null,
      urlFetchApiKeyIv: null,
    },
  });

  expect(availability).toEqual({
    status: "unavailable",
    reason: "key-unreadable",
  });
});
