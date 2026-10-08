import { panic } from "better-result";
import * as v from "valibot";

import type { McpToolDefinition } from "./tool-types";

const visibilitySchema = v.pipe(
  v.array(v.picklist(["model", "app"])),
  v.nonEmpty(),
);

/** MCP Apps defaults omitted visibility to both audiences. */
export const isMcpToolVisibleTo = (
  definition: Pick<McpToolDefinition, "_meta">,
  audience: "model" | "app",
): boolean => {
  const ui = definition._meta?.["ui"];
  if (ui === undefined) {
    return true;
  }
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return panic("MCP tool UI metadata must be an object");
  }
  if (!("visibility" in ui) || ui.visibility === undefined) {
    return true;
  }
  const parsed = v.safeParse(visibilitySchema, ui.visibility);
  if (!parsed.success) {
    return panic("MCP tool visibility must declare model or app audiences");
  }
  return parsed.output.includes(audience);
};
