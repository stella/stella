/**
 * The one table naming the client-engagement container on the agent surface.
 *
 * A capability input field is a `workspaceId` in the DB, the handler config and
 * the REST route, and a `matterId` to every agent. Both directions of that
 * rename are derived from this record, so the catalog exporter's outbound
 * projection (`withPublicFieldNames`, apps/api/scripts/export-capability-catalog.ts)
 * and `invoke_capability`'s inbound one (`withInternalFieldNames`,
 * apps/api/src/mcp/capability-tools.ts) cannot disagree about which fields are
 * renamed or how.
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
