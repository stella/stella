import * as v from "valibot";

export const CHAT_PROJECTION_METADATA_KEY = "chatProjection";

/**
 * The widened schema type used by the runtime projection registry. Individual
 * annotated field builders retain their inferred input/output types so the
 * same schemas can provide precise handler contracts at compile time; only the
 * heterogeneous registry boundary widens them for AST walking.
 */
export type ChatProjectionSchema = v.GenericSchema<
  Record<string, unknown>,
  Record<string, unknown>
>;

const selectedProjectionBranches = new WeakMap<
  Record<string, unknown>,
  ChatProjectionSchema
>();

const projectionBranchSources = new WeakMap<
  v.GenericSchema,
  ChatProjectionSchema
>();

/**
 * Mark one union/variant option as a projection branch. Its Valibot transform
 * records which schema produced the canonical output object during the one
 * strict parse; the annotation walk can then follow that branch without
 * validating it again.
 */
export const projectionBranch = <TSchema extends ChatProjectionSchema>(
  schema: TSchema,
) => {
  const branch = v.pipe(
    schema,
    v.transform((output) => {
      selectedProjectionBranches.set(output, schema);
      return output;
    }),
  );
  projectionBranchSources.set(branch, schema);
  return branch;
};

export const getProjectionBranchSource = (schema: v.GenericSchema) =>
  projectionBranchSources.get(schema);
export const getSelectedProjectionBranch = (value: Record<string, unknown>) =>
  selectedProjectionBranches.get(value);
/**
 * A non-tenant handle (user/version/link/library id, opaque cursor) the model
 * may pass back verbatim; licensed to survive the runtime UUID backstop.
 */
export const passthroughId = () =>
  v.pipe(
    v.string(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "passthroughId" } }),
  );

/**
 * A public URL assigned by an external publisher (a court's decision portal,
 * a legislature's official gazette), which may embed a UUID of the
 * publisher's own minting rather than a Stella tenant id. Forwarded verbatim
 * and excluded from the runtime UUID invariant: the publisher's UUID is not a
 * tenant identifier the chat ref registry needs to mediate, and rewriting or
 * refusing it would break the link. Distinct from `passthroughId`, which is
 * reserved for opaque internal handles, not externally owned URLs.
 */
export const publicUrl = () =>
  v.pipe(
    v.string(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "publicUrl" } }),
  );
