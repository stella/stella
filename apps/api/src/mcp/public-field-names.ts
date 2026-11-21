import { panic } from "better-result";

import { isUnknownArray } from "@/api/lib/type-guards";

/**
 * The one table naming the client-engagement container on the agent surface.
 *
 * A capability input field is a `workspaceId` in the DB, the handler config and
 * the REST route, and a `matterId` to every agent. Both directions of that
 * rename are derived from this record, so the outbound projection
 * (`withPublicFieldNames`, below) and the capability executors' inbound one
 * (`withInternalFieldNames`, apps/api/src/mcp/capability-tools.ts) cannot
 * disagree about which fields are renamed or how.
 *
 * Every entry is an exact key, never a substring: `matterCode`,
 * `matterNumberPattern` and the like are unrelated words that must not move.
 * Both projections walk a schema (and a value) to any depth, so a container
 * nested inside a union branch, an array item or a sub-object is renamed too
 * (`flows.create` body.trigger, `playbooks.create` positions passages,
 * `signals.acceptances.create` body.result).
 *
 * Keyed public -> internal, the direction the wire is read in.
 */
const FIELD_NAMES = {
  matterContactId: "workspaceContactId",
  matterId: "workspaceId",
  matterIds: "workspaceIds",
  targetMatterId: "targetWorkspaceId",
} as const satisfies Record<string, string>;

/** Public input field name -> the internal name the handlers declare. */
export const INTERNAL_FIELD_NAME: Readonly<Record<string, string>> =
  FIELD_NAMES;

/** The same table read the other way: internal name -> the advertised one. */
export const PUBLIC_FIELD_NAME: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(FIELD_NAMES).map(([publicName, internal]) => [
      internal,
      publicName,
    ]),
  );

/**
 * Whether a schema node declares any internal container name of its own.
 *
 * This is the per-node exemption both projections turn on: a node that names
 * the container internally is projected, and a node that already owns the
 * public spelling (`expenses.create` body declares `matterId`, `signals.list`
 * query declares `matterId`) has nothing to rename and is left alone.
 */
export const declaresInternalField = (schemaNode: unknown): boolean => {
  if (!isPlainRecord(schemaNode)) {
    return false;
  }
  const properties = schemaNode["properties"];
  if (!isPlainRecord(properties)) {
    return false;
  }
  return Object.keys(properties).some(
    (name) => PUBLIC_FIELD_NAME[name] !== undefined,
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Schema keywords whose value is itself a schema node. */
const SCHEMA_NODE_KEYWORDS = ["items", "additionalProperties", "not"] as const;
/** Schema keywords whose value is a list of schema nodes. */
const SCHEMA_NODE_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;
/** Schema keywords whose value maps names to schema nodes. */
const SCHEMA_NODE_MAP_KEYWORDS = [
  "properties",
  "$defs",
  "definitions",
] as const;

/**
 * Rename internal input fields to their public spelling on the way out, at
 * every depth.
 *
 * The container is a `workspaceId` in the DB, the handler config and the REST
 * route; it is a `matterId` to every agent. This is the outbound half of that
 * split: the catalog exporter (`buildInputSchema`) and `describe_capability`
 * both advertise through it, so the CLI's generated `--matter-id` flag and the
 * MCP description name the field the capability executors accept. The inbound half is `withInternalFieldNames`
 * (apps/api/src/mcp/capability-tools.ts), which renames the field back before
 * the handler's own schema validates it, so the two names never both reach a
 * handler. Both halves derive from `PUBLIC_FIELD_NAME`'s one table.
 *
 * The walk covers every place a schema node can hide (`properties`, `items`,
 * `additionalProperties`, `anyOf`/`oneOf`/`allOf`, `$defs`), because the
 * container is not always top level: `flows.create` carries it inside a union
 * branch of `body.trigger`, `playbooks.create` inside an array of passages,
 * `signals.acceptances.create` inside `body.result`. Renaming only the top
 * level would advertise `--matter-id` on one capability and
 * `--body-trigger-workspace-id` on the next.
 *
 * The exemption is evaluated per NODE, not per part: a node that already owns
 * the public name (`expenses.create` body declares its own `matterId`) has no
 * internal name to rename, so the two cannot meet.
 */
export const withPublicFieldNames = (node: unknown): unknown => {
  if (isUnknownArray(node)) {
    return node.map((entry) => withPublicFieldNames(entry));
  }
  if (!isPlainRecord(node)) {
    return node;
  }
  const rename = (name: string): string =>
    Object.hasOwn(PUBLIC_FIELD_NAME, name)
      ? (PUBLIC_FIELD_NAME[name] ?? name)
      : name;
  const projected = new Map(Object.entries(node));

  for (const keyword of SCHEMA_NODE_KEYWORDS) {
    if (keyword in node) {
      projected.set(keyword, withPublicFieldNames(node[keyword]));
    }
  }
  for (const keyword of SCHEMA_NODE_LIST_KEYWORDS) {
    const branches = node[keyword];
    if (isUnknownArray(branches)) {
      projected.set(
        keyword,
        branches.map((branch) => withPublicFieldNames(branch)),
      );
    }
  }
  for (const keyword of SCHEMA_NODE_MAP_KEYWORDS) {
    const members = node[keyword];
    if (!isPlainRecord(members)) {
      continue;
    }
    // `$defs`/`definitions` name reusable schemas, not input fields, so only
    // `properties` keys are renamed; every value is still descended into.
    const renameKeys = keyword === "properties";
    if (renameKeys) {
      for (const [internal, publicName] of Object.entries(PUBLIC_FIELD_NAME)) {
        if (internal in members && publicName in members) {
          panic(
            `capability input declares both ${internal} and ${publicName}; the public rename would drop one`,
          );
        }
      }
    }
    projected.set(
      keyword,
      Object.fromEntries(
        Object.entries(members).map(([name, member]) => [
          renameKeys ? rename(name) : name,
          withPublicFieldNames(member),
        ]),
      ),
    );
  }

  const required = node["required"];
  if (isUnknownArray(required)) {
    projected.set(
      "required",
      required.map((name) => (typeof name === "string" ? rename(name) : name)),
    );
  }
  return Object.fromEntries(projected);
};
