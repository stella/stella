import * as v from "valibot";

export const DECISION_SECTION_TYPES = [
  "header",
  "history",
  "argumentation",
  "ruling",
  "dissent",
  "footer",
  "unknown",
] as const;

export type DecisionSectionType = (typeof DECISION_SECTION_TYPES)[number];

export type DecisionSection = {
  index: number;
  type: DecisionSectionType;
  title: string | null;
  text: string;
};

export const decisionSectionSchema: v.GenericSchema<DecisionSection> = v.object(
  {
    index: v.number(),
    type: v.picklist(DECISION_SECTION_TYPES),
    title: v.nullable(v.string()),
    text: v.string(),
  },
);

export const persistedDecisionSectionsSchema = v.nullable(
  v.array(decisionSectionSchema),
);

/** Empty AST placeholder for legal documents without a parser. */
export type EmptyAst = Record<string, never>;

/** Constant empty AST for sources without a parser. */
export const EMPTY_AST: EmptyAst = {};

export const emptyAstSchema: v.GenericSchema<EmptyAst> = v.custom<EmptyAst>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 0,
  "Expected a plain empty AST object",
);
