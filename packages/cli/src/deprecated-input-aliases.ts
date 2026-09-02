import { MCP_DEPRECATED_INPUT_ALIASES } from "./generated/mcp-contract.js";

/**
 * The server accepts a deprecated tool-input name for one release and rewrites
 * it onto its replacement at dispatch. The CLI validates `--input` against the
 * baked schema BEFORE it ever contacts the server, so without the same rewrite
 * here a caller following a field description (`Deprecated input alias:
 * matter_id.`) would be rejected locally and never reach that server-side
 * normalization.
 *
 * The alias table itself is generated from the API's own map
 * (`generated/mcp-contract.ts`), so the two surfaces cannot disagree about
 * WHICH names are aliased; only the (small) rewrite rule is stated twice, once
 * per package. Both go when the deprecation window closes.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Canonical name -> the deprecated name it replaced. */
export const DEPRECATED_NAME_BY_CANONICAL_INPUT: Readonly<
  Record<string, string>
> = Object.fromEntries(
  Object.entries(MCP_DEPRECATED_INPUT_ALIASES).map(([alias, canonical]) => [
    canonical,
    alias,
  ]),
);

export type DeprecatedInputAliasResult =
  | { status: "normalized"; args: Record<string, unknown> }
  | { status: "conflict"; alias: string; canonical: string };

/**
 * Rewrites deprecated input names onto their canonical field. A deprecated name
 * the schema still declares is left alone (the tool genuinely owns it), and
 * supplying both names with different values is a conflict rather than a silent
 * winner — the same three rules the server applies.
 */
export const applyDeprecatedInputAliases = ({
  args,
  inputSchema,
}: {
  args: Record<string, unknown>;
  inputSchema: unknown;
}): DeprecatedInputAliasResult => {
  const rawProperties = isRecord(inputSchema)
    ? inputSchema["properties"]
    : undefined;
  const properties = isRecord(rawProperties) ? rawProperties : {};
  const renames = new Map<string, string>();

  for (const [alias, canonical] of Object.entries(
    MCP_DEPRECATED_INPUT_ALIASES,
  )) {
    const applies =
      alias in args && !(alias in properties) && canonical in properties;
    if (!applies) {
      continue;
    }
    if (canonical in args && args[canonical] !== args[alias]) {
      return { alias, canonical, status: "conflict" };
    }
    renames.set(alias, canonical);
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
