import { panic } from "better-result";
import type { InferOk } from "better-result";

import { hasUsableAst } from "@/api/lib/case-law/document-ast";
import {
  corpusContentHash,
  type CorpusPayload,
} from "@/api/lib/legal-search/corpus-payload";

import { compareRetention } from "./compare";
import { readOutputText } from "./output";
import { readSourceTextBaseline, type SourceInputError } from "./source-input";
import {
  ORACLE_VERSION,
  TEXT_ORACLE_LIMITS,
  type TextOracleError,
} from "./types";

export const EXCLUSION_VERSION = 1;

type RetentionVerdict = InferOk<ReturnType<typeof compareRetention>>;
type SourceInput = Parameters<typeof readSourceTextBaseline>[0];
export type AssessmentReason =
  | SourceInputError["reason"]
  | TextOracleError["reason"]
  | "no_raw"
  | "composite_unreverifiable"
  | "ambiguous_component"
  | "missing_output"
  | "unknown_source"
  | "raw_mismatch"
  | "payload_mismatch"
  | "raw_read_failed"
  | "payload_read_failed"
  | "missing_snapshot"
  | "source_mismatch";
type ValidationFailure = { status: "unavailable"; reason: AssessmentReason };
type Assessment = RetentionVerdict | ValidationFailure;
type ComponentAssessment = {
  id: string;
  rawFingerprint: string | null;
  payloadFingerprint: string;
  verdict: Assessment;
};

export type PayloadAssessment = {
  rawFingerprint: string | null;
  payloadFingerprint: string;
  compositionFingerprint: string;
  components: ComponentAssessment[];
  parserVersion: number;
  oracleVersion: number;
  exclusionVersion: number;
  verdict: Assessment;
};

const digest = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

type CompositionFingerprintOptions = {
  rawFingerprint: string | null;
  payloadFingerprint: string;
  components: readonly Pick<
    ComponentAssessment,
    "id" | "rawFingerprint" | "payloadFingerprint"
  >[];
};

export const retentionCompositionFingerprint = ({
  rawFingerprint,
  payloadFingerprint,
  components,
}: CompositionFingerprintOptions) =>
  digest(
    new TextEncoder().encode(
      JSON.stringify({
        root: { rawFingerprint, payloadFingerprint },
        components: components.map(
          ({ id, rawFingerprint: raw, payloadFingerprint: payload }) => ({
            id,
            rawFingerprint: raw,
            payloadFingerprint: payload,
          }),
        ),
      }),
    ),
  );

type WorstAssessmentOptions = { current: Assessment; candidate: Assessment };
/** An unassessed or defective component cannot be offset by a stronger aggregate. */
const worstAssessment = ({
  current,
  candidate,
}: WorstAssessmentOptions): Assessment => {
  switch (candidate.status) {
    case "unavailable":
      return current.status === "unavailable" ? current : candidate;
    case "empty_source":
      return current.status === "unavailable" ? current : candidate;
    case "assessed":
      switch (current.status) {
        case "unavailable":
        case "empty_source":
          return current;
        case "assessed":
          if (candidate.defect !== null && current.defect === null) {
            return candidate;
          }
          if (current.defect !== null && candidate.defect === null) {
            return current;
          }
          return candidate.retainedRatio < current.retainedRatio
            ? candidate
            : current;
        default:
          current satisfies never;
          return panic("Unhandled existing retention assessment");
      }
    default:
      candidate satisfies never;
      return panic("Unhandled candidate retention assessment");
  }
};

/** Every served representation is checked; an AST pass cannot hide a lossy fulltext. */
const assessPayload = (source: string, payload: CorpusPayload): Assessment => {
  const outputs = [];
  if (hasUsableAst(payload.ast)) {
    outputs.push(readOutputText({ type: "ast", documentAst: payload.ast }));
  }
  if (payload.text !== null) {
    outputs.push(readOutputText({ type: "fulltext", fulltext: payload.text }));
  }
  if (payload.sections !== null && payload.sections.length > 0) {
    outputs.push(
      readOutputText({
        type: "fulltext",
        fulltext: payload.sections.map((section) => section.text).join("\n"),
      }),
    );
  }
  if (outputs.length === 0) {
    return { status: "unavailable", reason: "missing_output" };
  }
  let worst: Assessment | null = null;
  for (const output of outputs) {
    if (output.isErr()) {
      return { status: "unavailable", reason: output.error.reason };
    }
    const comparison = compareRetention({ source, output: output.value.text });
    if (comparison.isErr()) {
      return { status: "unavailable", reason: comparison.error.reason };
    }
    worst =
      worst === null
        ? comparison.value
        : worstAssessment({ current: worst, candidate: comparison.value });
  }
  return worst ?? panic("A served output produces a retention assessment");
};

type AssessmentComponent = {
  id: string;
  source: SourceInput | null;
  /** The component output BEFORE composition or absorption. */
  payload: CorpusPayload;
};
type AssessRawPayloadOptions = {
  source: SourceInput | null;
  /** The FINAL canonical payload selected for persistence, including annotations. */
  payload: CorpusPayload;
  parserVersion: number;
  /** Complete precomposition manifest, including the judgment; empty means one source. */
  components?: readonly AssessmentComponent[];
};
type SourceBaseline = Awaited<ReturnType<typeof readSourceTextBaseline>>;

/** Shared by live writes and dry runs; I/O comes only from the injected binary reader. */
export const assessRawPayload = async ({
  source,
  payload,
  parserVersion,
  components = [],
}: AssessRawPayloadOptions): Promise<PayloadAssessment> => {
  const rawFingerprint = source === null ? null : digest(source.raw);
  const payloadFingerprint = corpusContentHash(payload);
  const componentFingerprints = components.map(
    ({ id, source: componentSource, payload: componentPayload }) => ({
      id,
      rawFingerprint:
        componentSource === null ? null : digest(componentSource.raw),
      payloadFingerprint: corpusContentHash(componentPayload),
    }),
  );
  const compositionFingerprint = retentionCompositionFingerprint({
    rawFingerprint,
    payloadFingerprint,
    components: componentFingerprints,
  });
  const assessedComponents: ComponentAssessment[] = [];
  const baselines = new Map<string, Promise<SourceBaseline>>();
  const sharedBinaryCache = new Map<string, Uint8Array>();
  const baselineFor = (input: SourceInput, fingerprint: string) => {
    const identity = JSON.stringify([
      input.sourceKey,
      input.contentType,
      fingerprint,
    ]);
    const known = baselines.get(identity);
    if (known !== undefined) {
      return known;
    }
    const pending = readSourceTextBaseline({
      ...input,
      binaryCache: input.binaryCache ?? sharedBinaryCache,
    });
    baselines.set(identity, pending);
    return pending;
  };
  const rootBaseline =
    source === null
      ? null
      : await baselineFor(
          source,
          rawFingerprint ?? panic("Raw source has a fingerprint"),
        );
  let verdict: Assessment;
  if (rootBaseline === null) {
    verdict = { status: "unavailable", reason: "no_raw" };
  } else if (rootBaseline.isErr()) {
    verdict = { status: "unavailable", reason: rootBaseline.error.reason };
  } else {
    verdict = assessPayload(rootBaseline.value.text, payload);
  }

  if (components.length > 0) {
    // The root is represented by a component rather than concatenated a second time.
    const includesRoot =
      source !== null &&
      components.some(
        ({ source: componentSource }, index) =>
          componentSource !== null &&
          componentSource.sourceKey === source.sourceKey &&
          componentSource.contentType === source.contentType &&
          componentFingerprints.at(index)?.rawFingerprint === rawFingerprint,
      );
    if (!includesRoot) {
      verdict = { status: "unavailable", reason: "composite_unreverifiable" };
    }
    const seen = new Set<string>();
    const aggregate: string[] = [];
    let characters = 0;
    let aggregateFailure: ValidationFailure | null = null;
    for (const [index, component] of components.entries()) {
      const fingerprints =
        componentFingerprints.at(index) ??
        panic("Every component has fingerprints");
      const componentBaseline =
        component.source === null
          ? null
          : await baselineFor(
              component.source,
              fingerprints.rawFingerprint ??
                panic("Component raw has a fingerprint"),
            );
      let componentVerdict: Assessment;
      if (component.id.trim() === "" || seen.has(component.id)) {
        componentVerdict = {
          status: "unavailable",
          reason: "ambiguous_component",
        };
      } else if (componentBaseline === null) {
        componentVerdict = { status: "unavailable", reason: "no_raw" };
      } else if (componentBaseline.isErr()) {
        componentVerdict = {
          status: "unavailable",
          reason: componentBaseline.error.reason,
        };
      } else {
        componentVerdict = assessPayload(
          componentBaseline.value.text,
          component.payload,
        );
      }
      seen.add(component.id);
      assessedComponents.push({ ...fingerprints, verdict: componentVerdict });
      verdict = worstAssessment({
        current: verdict,
        candidate: componentVerdict,
      });
      if (componentBaseline === null || componentBaseline.isErr()) {
        aggregateFailure = {
          status: "unavailable",
          reason:
            componentBaseline === null
              ? "no_raw"
              : componentBaseline.error.reason,
        };
        continue;
      }
      characters += componentBaseline.value.text.length + 1;
      if (characters > TEXT_ORACLE_LIMITS.textCharacters) {
        aggregateFailure = { status: "unavailable", reason: "resource_limit" };
        continue;
      }
      aggregate.push(componentBaseline.value.text);
    }
    const finalVerdict =
      aggregateFailure ?? assessPayload(aggregate.join("\n"), payload);
    verdict = worstAssessment({ current: verdict, candidate: finalVerdict });
  }
  return {
    rawFingerprint,
    payloadFingerprint,
    compositionFingerprint,
    components: assessedComponents,
    parserVersion,
    oracleVersion: ORACLE_VERSION,
    exclusionVersion: EXCLUSION_VERSION,
    verdict,
  };
};
