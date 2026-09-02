import type { McpToolInputSchema } from "@/api/mcp/tool-types";

/**
 * Deprecated MCP input field names, each mapped to the field it was renamed to.
 *
 * The scoping container is a workspace everywhere else in the product (the UI,
 * the CLI capability commands, and every handler, which maps the field straight
 * to `workspaceId`), so the tools name it `workspace_id`. `matter_id` stays
 * accepted for one release so an existing agent prompt keeps working; it is
 * normalized here, at dispatch, rather than per tool, so the advertised schema
 * names only the canonical field and the rename cannot be half-applied.
 *
 * A tool whose subject IS the matter record (`save_matter`, `delete_matter`,
 * `list_matters`, `link_matter_contact`) declares `matter_id` itself; the alias
 * never applies there, because the rewrite is keyed off the advertised schema.
 *
 * Delete this module when the deprecation window closes.
 */
export const DEPRECATED_MCP_INPUT_ALIASES = {
  matter_id: "workspace_id",
} as const satisfies Record<string, string>;

/** A deprecated name and its replacement, both supplied with different values. */
export type DeprecatedInputAliasConflict = {
  alias: string;
  canonical: string;
};

type DeprecatedInputAliasNormalization =
  | { status: "normalized"; args: Record<string, unknown> }
  | { status: "conflict"; conflicts: readonly DeprecatedInputAliasConflict[] };

/**
 * Rewrites deprecated input names onto their canonical field for one tool call.
 * A deprecated name the tool still declares is left alone, and supplying both
 * names with different values is a conflict rather than a silent winner.
 */
export const applyDeprecatedInputAliases = ({
  args,
  inputSchema,
}: {
  args: Record<string, unknown>;
  inputSchema: McpToolInputSchema;
}): DeprecatedInputAliasNormalization => {
  const properties = inputSchema.properties ?? {};
  const conflicts: DeprecatedInputAliasConflict[] = [];
  const renames = new Map<string, string>();

  for (const [alias, canonical] of Object.entries(
    DEPRECATED_MCP_INPUT_ALIASES,
  )) {
    const applies =
      alias in args && !(alias in properties) && canonical in properties;
    if (!applies) {
      continue;
    }
    if (canonical in args && args[canonical] !== args[alias]) {
      conflicts.push({ alias, canonical });
      continue;
    }
    renames.set(alias, canonical);
  }

  if (conflicts.length > 0) {
    return { conflicts, status: "conflict" };
  }
  if (renames.size === 0) {
    return { args, status: "normalized" };
  }
  return {
    args: Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        renames.get(key) ?? key,
        value,
      ]),
    ),
    status: "normalized",
  };
};

export const deprecatedInputAliasConflictMessage = ({
  alias,
  canonical,
}: DeprecatedInputAliasConflict): string =>
  `${alias} is a deprecated alias for ${canonical}; they were supplied with different values`;
