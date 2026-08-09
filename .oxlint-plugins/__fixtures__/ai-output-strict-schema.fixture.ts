// Passive regression fixture for
// `ai-output-strict-schema/ai-output-strict-schema`.

declare const Output: {
  array: (options: unknown) => unknown;
  object: (options: unknown) => unknown;
};
declare const schema: unknown;
declare const strictOutputSchema: (value: unknown) => unknown;
declare const valibotSchema: (value: unknown) => unknown;

// MUST flag: the loose conversion is nested inside the Output options.
export const looseObjectOutput = Output.object({
  // oxlint-disable-next-line ai-output-strict-schema/ai-output-strict-schema -- fixture: Output.object must recursively reject a loose Valibot conversion
  schema: { value: valibotSchema(schema) },
});

// MUST flag: Output.array has the same strict-schema boundary.
export const looseArrayOutput = Output.array({
  // oxlint-disable-next-line ai-output-strict-schema/ai-output-strict-schema -- fixture: Output.array must reject a loose Valibot conversion
  element: valibotSchema(schema),
});

// Allowed: the sanctioned helper recursively pins strict object schemas.
export const strictObjectOutput = Output.object({
  schema: strictOutputSchema(schema),
});

// Allowed: unrelated valibotSchema calls are outside Output.* boundaries.
export const ordinarySchema = valibotSchema(schema);
