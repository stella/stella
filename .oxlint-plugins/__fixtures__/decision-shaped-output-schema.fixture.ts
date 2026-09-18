// Passive regression fixture for
// `decision-shaped-output-schema/decision-shaped-output-schema`.

declare const v: {
  array: (schema: unknown) => unknown;
  boolean: () => unknown;
  integer: () => unknown;
  isoDate: () => unknown;
  literal: (value: unknown) => unknown;
  nullable: (schema: unknown) => unknown;
  number: () => unknown;
  object: (entries: Record<string, unknown>) => unknown;
  optional: (schema: unknown) => unknown;
  picklist: (values: readonly string[]) => unknown;
  pipe: (...steps: unknown[]) => unknown;
  strictObject: (entries: Record<string, unknown>) => unknown;
  string: () => unknown;
  union: (members: readonly unknown[]) => unknown;
};
declare const describeSchema: (schema: unknown) => unknown;
declare const generateTanStackObjectForRole: (
  options: Record<string, unknown>,
) => Promise<unknown>;
declare const streamTanStackObjectForRole: (
  options: Record<string, unknown>,
) => AsyncIterable<unknown>;
declare const parseWithSchema: (options: Record<string, unknown>) => unknown;

const SEVERITIES = ["low", "high"] as const;

// MUST flag: a single boolean field is a yes/no the decision model answers.
export const booleanOnly = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    // oxlint-disable-next-line decision-shaped-output-schema/decision-shaped-output-schema -- fixture: a boolean-only output schema must route to decide()
    outputSchema: v.strictObject({ applies: v.boolean() }),
  });

// MUST flag: a closed choice, a bounded integer and a date are all decisions.
export const closedChoicesAndNumbers = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    // oxlint-disable-next-line decision-shaped-output-schema/decision-shaped-output-schema -- fixture: picklist, integer and ISO date fields carry no prose
    outputSchema: v.object({
      severity: v.picklist(SEVERITIES),
      rank: v.pipe(v.number(), v.integer()),
      signedOn: v.pipe(v.string(), v.isoDate()),
      supersedes: v.nullable(v.literal("previous")),
    }),
  });

// MUST flag: the schema is a same-file const, and rows of decisions are still
// decisions.
const rowDispositionSchema = v.strictObject({
  rows: v.array(
    v.object({
      n: v.pipe(v.number(), v.integer()),
      disposition: v.union([v.literal("keep"), v.picklist(SEVERITIES)]),
      confirmed: v.optional(v.boolean()),
    }),
  ),
});

export const sameFileConstant = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    // oxlint-disable-next-line decision-shaped-output-schema/decision-shaped-output-schema -- fixture: a same-file schema constant must resolve through its identifier
    outputSchema: rowDispositionSchema,
  });

// MUST flag: one level of pipe wrapping around the object literal, on the
// streaming entry point.
const pipedVerdictSchema = describeSchema(
  v.pipe(v.strictObject({ verdict: v.picklist(SEVERITIES) })),
);

export const pipeWrapped = () =>
  streamTanStackObjectForRole({
    role: "fixture",
    // oxlint-disable-next-line decision-shaped-output-schema/decision-shaped-output-schema -- fixture: pipe-wrapped object literals must resolve to their entries
    outputSchema: v.pipe(v.strictObject({ verdict: v.picklist(SEVERITIES) })),
  });

// Allowed: a free-text field keeps the call generative.
export const proseOnly = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    outputSchema: v.strictObject({ summary: v.string() }),
  });

// Allowed: prose beside a closed choice still needs the generative model.
export const proseBesideChoice = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    outputSchema: v.strictObject({
      verdict: v.picklist(SEVERITIES),
      rationale: v.string(),
    }),
  });

// Allowed: an entry list with nothing in it decides nothing.
export const emptySchema = async () =>
  await generateTanStackObjectForRole({
    role: "fixture",
    outputSchema: v.strictObject({}),
  });

// Allowed: the schema is declared in another module, so this file cannot prove
// its shape.
export const unresolvedSchema = async (importedSchema: unknown) =>
  await generateTanStackObjectForRole({
    role: "fixture",
    outputSchema: importedSchema,
  });

// MUST flag: a file-local wrapper around the generative helper takes the same
// `outputSchema` option, and the decision is written where the literal is.
export const throughWrapper = parseWithSchema({
  // oxlint-disable-next-line decision-shaped-output-schema/decision-shaped-output-schema -- fixture: the option name, not the callee, marks a structured-output call
  outputSchema: v.strictObject({ applies: v.boolean() }),
});

// Allowed: the wrapper itself forwards a schema it cannot resolve.
export const wrapperBody = async (input: { outputSchema: unknown }) =>
  await generateTanStackObjectForRole({
    role: "fixture",
    outputSchema: input.outputSchema,
  });

export { pipedVerdictSchema };
