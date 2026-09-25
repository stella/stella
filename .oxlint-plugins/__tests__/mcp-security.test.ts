import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const SOURCE = [
  'import { mcpOAuthClients } from "@/api/db/schema";',
  "export const rows = db.select().from(connections).leftJoin(mcpOAuthClients, on);",
  "",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule("no-direct-oauth-client-join", SOURCE, {
    plugin: "mcp-security",
    sourcePath,
  });

describe.serial("no-direct-oauth-client-join", () => {
  test("reports an OAuth client join outside the connection loader", async () => {
    expect(await lint("apps/api/src/handlers/chat/tools/elsewhere.ts")).toEqual(
      [2],
    );
  });

  test("accepts the join in the typed MCP connection loader", async () => {
    expect(await lint("apps/api/src/lib/mcp-upstream/connections.ts")).toEqual(
      [],
    );
  });
});
