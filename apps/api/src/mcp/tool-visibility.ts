import { panic } from "better-result";
import * as v from "valibot";

const visibilitySchema = v.pipe(
  v.array(v.picklist(["model", "app"])),
  v.nonEmpty(),
);

export type McpToolAudience = "model" | "app";

/** A definition's statically declared audience slice; omitted metadata is shared. */
export type McpToolVisibleTo<
  TDefinition,
  TAudience extends McpToolAudience,
> = TDefinition extends {
  _meta: {
    ui: {
      visibility: infer TVisibility extends readonly McpToolAudience[];
    };
  };
}
  ? TAudience extends TVisibility[number]
    ? TDefinition
    : never
  : TDefinition;

/**
 * MCP Apps defaults omitted visibility to both audiences. Metadata is read as
 * unknown and validated here, so any definition's literal `_meta` (readonly
 * tuples from `as const` registries included) is accepted, while literal
 * audience metadata narrows registry unions for the selected consumer.
 */
export const isMcpToolVisibleTo = <
  const TDefinition extends object,
  const TAudience extends McpToolAudience,
>(
  definition: TDefinition,
  audience: TAudience,
): definition is TDefinition & McpToolVisibleTo<TDefinition, TAudience> => {
  if (!("_meta" in definition) || definition._meta === undefined) {
    return true;
  }
  const meta = definition._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return panic("MCP tool metadata must be an object");
  }
  const ui = "ui" in meta ? meta.ui : undefined;
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
