import { describe, expect, test } from "bun:test";

import {
  getStaticMcpToolDefinition,
  LAW_MCP_TOOL_DISPOSITION,
} from "@/api/mcp/static-tool-definitions";
import { isMcpToolVisibleTo } from "@/api/mcp/tool-visibility";

const README_PATH = "apps/api/src/mcp/README.md";

// The README counts what a model can call; app-only tools serve the host's UI.
const lawSurfaceToolNames = Object.entries(LAW_MCP_TOOL_DISPOSITION)
  .filter(([name, disposition]) => {
    const definition = getStaticMcpToolDefinition(name, "law");
    return (
      disposition === "corpus" &&
      definition !== undefined &&
      isMcpToolVisibleTo(definition, "model")
    );
  })
  .map(([name]) => name);

const LAW_TOOL_CLAIM =
  /Exactly (?<count>\d+) read tools\s*\((?<tools>[^)]*)\)/u;

const readme = await Bun.file(new URL("README.md", import.meta.url)).text();
const claim = LAW_TOOL_CLAIM.exec(readme)?.groups;

describe("mcp README law surface", () => {
  test("the README still claims a law tool count and list", () => {
    expect(
      claim,
      `${README_PATH} no longer contains an "Exactly <count> read tools (...)" claim for the /mcp-law audience; restore that sentence so this guard can check it against LAW_MCP_TOOL_DISPOSITION`,
    ).toBeDefined();
  });

  test("the stated count is the number of law-surface tools", () => {
    expect(
      Number(claim?.["count"]),
      `${README_PATH} count disagrees with the law registry`,
    ).toBe(lawSurfaceToolNames.length);
  });

  test("the listed tools are exactly the law-surface tools", () => {
    const listed = [...(claim?.["tools"] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      // A capture group is typed as possibly absent; the pattern cannot
      // match without it, so a missing one would be a broken pattern.
      ([, name]) => name ?? "",
    );

    expect(
      listed.toSorted(),
      `the /mcp-law tool list in ${README_PATH} disagrees with LAW_MCP_TOOL_DISPOSITION, whose model-visible "corpus" tools are: ${lawSurfaceToolNames.join(", ")}`,
    ).toEqual(lawSurfaceToolNames.toSorted());
  });
});
