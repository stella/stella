/**
 * Shared analysis model for AI-generated decision summaries.
 */

import { panic } from "better-result";
import * as v from "valibot";

export const CORE_CATEGORIES = [
  "facts",
  "procedural-history",
  "reasoning",
  "holding",
] as const;

export type CoreCategory = (typeof CORE_CATEGORIES)[number];

export type AnalysisAnnotation = {
  id: string;
  summary: string;
  startAnchorId: string;
  endAnchorId: string;
  textSnippet: string;
};

export type AnalysisHeading = {
  id: string;
  label: string;
  category: string;
  startAnchorId: string;
  endAnchorId: string;
  annotations: AnalysisAnnotation[];
  children: AnalysisHeading[];
};

/**
 * The document an analysis was computed over, as one value: a digest of
 * the exact text the model was shown, anchors included. Every anchor in
 * the tree names a block of that text, so an analysis whose fingerprint
 * differs from the current document's is stale, not merely old: a
 * re-parse that renumbers blocks moves every note onto the wrong
 * paragraph while the words stay the same. Readers compare before they
 * trust; a mismatch reads as no analysis.
 */
export type AnalysisInputFingerprint = string;

/**
 * What the whole cited-by neighbourhood of a decision was, as one value:
 * a digest of the citing decisions, their polarity and their courts. A
 * significance statement whose graph fingerprint differs from the
 * decision's current one was written about a graph that no longer exists,
 * so it is stale exactly the way an analysis over an old parse is stale.
 * It is deliberately a SECOND fence: the document does not change when a
 * later court distinguishes the decision, and the document fingerprint
 * therefore cannot notice it.
 */
export type AnalysisGraphFingerprint = string;

/** Bounds every layer is written, validated and laid out against. */
export const ANALYSIS_HOLDING_MAX_LENGTH = 400;
export const ANALYSIS_HOLDING_MAX_ANCHORS = 8;
export const ANALYSIS_ABSTRACT_MAX_LENGTH = 2000;
export const ANALYSIS_TOPIC_MAX_LENGTH = 60;
export const ANALYSIS_MAX_TOPICS = 12;
export const ANALYSIS_SIGNIFICANCE_MAX_LENGTH = 1200;

/** A passage of the decision, named the way an annotation names one. */
export type AnalysisAnchorRange = {
  startAnchorId: string;
  endAnchorId: string;
};

/**
 * The legal proposition a decision stands for: the sentence a lawyer would
 * quote when citing it as authority, plus the paragraphs it rests on, so a
 * reader can jump from the proposition to the text that carries it.
 *
 * It is not the publisher's own headnote (the editorial text a court or
 * publisher wrote, projected into the corpus index as `headnote`). The two
 * are separate fields with separate labels, and neither is ever written
 * into the other.
 */
export type AnalysisHolding = {
  text: string;
  language: string;
  anchors: AnalysisAnchorRange[];
};

/** The decision in a paragraph: facts, question, reasoning, outcome. */
export type AnalysisAbstract = {
  text: string;
  language: string;
};

/**
 * What later courts made of the decision. Written from the citation graph,
 * not from the document, so it carries its own provenance and its own
 * fence. Produced in-app only: it is a property of the corpus, which no
 * external producer of a document analysis can see.
 */
export type AnalysisSignificance = {
  text: string;
  language: string;
  graphFingerprint: AnalysisGraphFingerprint;
  generatedAt: string;
  model: string;
  /** Which revision of the significance prompt wrote this text. */
  promptVersion: number;
};

type DecisionAnalysisCore = {
  generatedAt: string;
  model: string;
  inputFingerprint: AnalysisInputFingerprint;
  tree: AnalysisHeading[];
};

/** Analyses written before the layers existed: read, never written. */
export type DecisionAnalysisV2 = DecisionAnalysisCore & { version: 2 };

/**
 * Every document-fenced layer is required: they are produced by one run
 * over one input, so an analysis that carries a tree but no holding is a
 * half-written record, not a lesser one. `significance` is the exception
 * because it is fenced on the graph instead, and is filled in later.
 */
export type DecisionAnalysisV3 = DecisionAnalysisCore & {
  version: 3;
  holding: AnalysisHolding;
  abstract: AnalysisAbstract;
  topics: string[];
  significance?: AnalysisSignificance;
};

export type DecisionAnalysis = DecisionAnalysisV2 | DecisionAnalysisV3;

/** The version every new analysis and every new sentinel is written at. */
export const CURRENT_ANALYSIS_VERSION = 3;

/**
 * The in-flight marker a generation run holds on the row. It carries the
 * current version, so a sentinel left behind by a previous release reads
 * as no analysis and the row becomes claimable again: a sentinel is state
 * a run holds for minutes, never a record worth migrating.
 */
export type AnalysisGenerating = {
  version: typeof CURRENT_ANALYSIS_VERSION;
  status: "generating";
  startedAt: string;
  inputFingerprint: AnalysisInputFingerprint;
};

export type PersistedDecisionAnalysis = DecisionAnalysis | AnalysisGenerating;

export const analysisAnnotationSchema: v.GenericSchema<AnalysisAnnotation> =
  v.object({
    id: v.string(),
    summary: v.pipe(v.string(), v.minLength(1)),
    startAnchorId: v.string(),
    endAnchorId: v.string(),
    // No length constraint: the prompt asks for short snippets,
    // but models routinely over-shoot. The UI truncates for display.
    textSnippet: v.string(),
  });

/** Schema for one heading emitted by the AI before Stella adds stable IDs and children. */
export const analysisHeadingInputSchema = v.object({
  id: v.string(),
  label: v.pipe(v.string(), v.minLength(1)),
  category: v.string(),
  startAnchorId: v.string(),
  endAnchorId: v.string(),
  annotations: v.array(analysisAnnotationSchema),
});

/** Complete persisted heading schema, including recursively nested children. */
export const analysisHeadingSchema: v.GenericSchema<AnalysisHeading> = v.object(
  {
    id: v.string(),
    label: v.pipe(v.string(), v.minLength(1)),
    category: v.string(),
    startAnchorId: v.string(),
    endAnchorId: v.string(),
    annotations: v.array(analysisAnnotationSchema),
    children: v.array(v.lazy(() => analysisHeadingSchema)),
  },
);

const inputFingerprintSchema = v.pipe(v.string(), v.minLength(1));

const graphFingerprintSchema = v.pipe(v.string(), v.minLength(1));

export const analysisAnchorRangeSchema: v.GenericSchema<AnalysisAnchorRange> =
  v.object({
    startAnchorId: v.string(),
    endAnchorId: v.string(),
  });

/**
 * The layer texts as a producer writes them: no `language`, because the
 * decision already names it, and Stella stamps it on. These are the
 * schemas the in-app run constrains its model with and the save
 * capability parses a submission through, so the two can never diverge.
 */
export const analysisHoldingInputSchema = v.object({
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(ANALYSIS_HOLDING_MAX_LENGTH),
  ),
  anchors: v.pipe(
    v.array(analysisAnchorRangeSchema),
    v.maxLength(ANALYSIS_HOLDING_MAX_ANCHORS),
  ),
});

export const analysisAbstractTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(ANALYSIS_ABSTRACT_MAX_LENGTH),
);

export const analysisTopicsSchema = v.pipe(
  v.array(
    v.pipe(v.string(), v.minLength(1), v.maxLength(ANALYSIS_TOPIC_MAX_LENGTH)),
  ),
  v.maxLength(ANALYSIS_MAX_TOPICS),
);

export const analysisHoldingSchema: v.GenericSchema<AnalysisHolding> =
  v.strictObject({
    text: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(ANALYSIS_HOLDING_MAX_LENGTH),
    ),
    language: v.pipe(v.string(), v.minLength(1)),
    anchors: v.pipe(
      v.array(analysisAnchorRangeSchema),
      v.maxLength(ANALYSIS_HOLDING_MAX_ANCHORS),
    ),
  });

export const analysisAbstractSchema: v.GenericSchema<AnalysisAbstract> =
  v.strictObject({
    text: analysisAbstractTextSchema,
    language: v.pipe(v.string(), v.minLength(1)),
  });

export const analysisSignificanceSchema: v.GenericSchema<AnalysisSignificance> =
  v.strictObject({
    text: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(ANALYSIS_SIGNIFICANCE_MAX_LENGTH),
    ),
    language: v.pipe(v.string(), v.minLength(1)),
    graphFingerprint: graphFingerprintSchema,
    generatedAt: v.string(),
    model: v.string(),
    promptVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  });

const decisionAnalysisCoreEntries = {
  generatedAt: v.string(),
  model: v.string(),
  inputFingerprint: inputFingerprintSchema,
  tree: v.array(analysisHeadingSchema),
} as const;

const decisionAnalysisV2Schema: v.GenericSchema<DecisionAnalysisV2> =
  v.strictObject({ version: v.literal(2), ...decisionAnalysisCoreEntries });

const decisionAnalysisV3Schema: v.GenericSchema<DecisionAnalysisV3> =
  v.strictObject({
    version: v.literal(3),
    ...decisionAnalysisCoreEntries,
    holding: analysisHoldingSchema,
    abstract: analysisAbstractSchema,
    topics: analysisTopicsSchema,
    // `exactOptional`, not `optional`: the field is absent or a statement,
    // never present and undefined, which is what the type says too.
    significance: v.exactOptional(analysisSignificanceSchema),
  });

/**
 * Version 1 carried no fingerprint, so nothing could tell whether its
 * anchors still named the document. Such a row is unreadable here on
 * purpose: it reads as no analysis and is regenerated against the current
 * document on the next open. Version 2 stays readable: its tree is exactly
 * a version 3 tree, it simply predates the other layers.
 */
export const decisionAnalysisSchema: v.GenericSchema<DecisionAnalysis> =
  v.union([decisionAnalysisV2Schema, decisionAnalysisV3Schema]);

const analysisGeneratingSchema: v.GenericSchema<AnalysisGenerating> =
  v.strictObject({
    version: v.literal(CURRENT_ANALYSIS_VERSION),
    status: v.literal("generating"),
    startedAt: v.string(),
    inputFingerprint: inputFingerprintSchema,
  });

const persistedDecisionAnalysisSchema: v.GenericSchema<PersistedDecisionAnalysis> =
  v.union([analysisGeneratingSchema, decisionAnalysisSchema]);

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  v.is(analysisGeneratingSchema, val);

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  v.is(decisionAnalysisSchema, val);

/**
 * Every layer beyond the tree, for a reader that must handle both stored
 * versions. A `switch` over the version rather than a property probe: a
 * version that adds or drops a layer fails the exhaustiveness check here,
 * once, instead of reading `undefined` at every call site.
 */
export type AnalysisLayers = {
  holding: AnalysisHolding | null;
  abstract: AnalysisAbstract | null;
  topics: string[];
  significance: AnalysisSignificance | null;
};

const NO_LAYERS: AnalysisLayers = {
  holding: null,
  abstract: null,
  topics: [],
  significance: null,
};

export const analysisLayersOf = (
  analysis: DecisionAnalysis,
): AnalysisLayers => {
  switch (analysis.version) {
    case 2:
      return NO_LAYERS;
    case 3:
      return {
        holding: analysis.holding,
        abstract: analysis.abstract,
        topics: analysis.topics,
        significance: analysis.significance ?? null,
      };
    default:
      analysis satisfies never;
      return panic("Unhandled decision analysis version");
  }
};

/**
 * Whether a stored significance still stands. Absent significance,
 * significance over an older graph, and significance from an older revision
 * of the prompt are one answer: it must be written again.
 *
 * The prompt version is part of the question because the graph fingerprint
 * digests the graph and nothing else, so a reworded prompt would otherwise
 * leave every already-analysed decision on the old wording indefinitely.
 */
export const isSignificanceCurrent = ({
  analysis,
  graphFingerprint,
  promptVersion,
}: {
  analysis: DecisionAnalysis;
  graphFingerprint: AnalysisGraphFingerprint;
  promptVersion: number;
}): boolean => {
  const significance = analysisLayersOf(analysis).significance;
  return (
    significance?.graphFingerprint === graphFingerprint &&
    significance.promptVersion === promptVersion
  );
};

export const parsePersistedDecisionAnalysis = (
  val: unknown,
): PersistedDecisionAnalysis | null => {
  let candidate = val;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  const result = v.safeParse(persistedDecisionAnalysisSchema, candidate);
  return result.success ? result.output : null;
};
