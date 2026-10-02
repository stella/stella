type FeatureDefinition = {
  enrolment: "invitation" | "self-serve";
  ownership?: {
    handlerDirectories: readonly string[];
    tableSchemaFiles: readonly string[];
    coreModules: readonly string[];
    conditionalModules?: readonly string[];
  };
};

export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;

export const FEATURE_REGISTRY = {} as const satisfies FeatureRegistry;

export type FeatureId = keyof typeof FEATURE_REGISTRY;
