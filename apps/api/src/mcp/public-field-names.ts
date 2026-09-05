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
 * Keyed public -> internal, the direction the wire is read in.
 */
const FIELD_NAMES = {
  matterContactId: "workspaceContactId",
  matterId: "workspaceId",
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
