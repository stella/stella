import { panic } from "better-result";
import * as v from "valibot";

const visibilitySchema = v.pipe(
  v.array(v.picklist(["model", "app"])),
  v.nonEmpty(),
);

/**
 * MCP Apps defaults omitted visibility to both audiences. Metadata is read as
 * unknown and validated here, so any definition's literal `_meta` (readonly
 * tuples from `as const` registries included) is accepted.
 */
export const isMcpToolVisibleTo = (
  definition: { readonly _meta?: Readonly<Record<string, unknown>> },
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
