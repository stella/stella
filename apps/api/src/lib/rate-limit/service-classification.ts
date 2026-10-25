export type ValidatedServiceInput = {
  body: unknown;
  params: unknown;
  query: unknown;
};

export type ServiceClassification =
  | boolean
  | ((input: ValidatedServiceInput) => boolean);

export const VALIDATED_INPUT_SERVICE_CLASSIFICATION = "validated_input";

export type CatalogServiceClassification =
  | boolean
  | typeof VALIDATED_INPUT_SERVICE_CLASSIFICATION;

export const isServiceClassification = (
  value: unknown,
): value is ServiceClassification =>
  typeof value === "boolean" || typeof value === "function";
