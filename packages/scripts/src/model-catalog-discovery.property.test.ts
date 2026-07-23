import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  findUnreviewedModels,
  MODEL_DISCOVERY_EPOCH,
  type UpstreamDiscoveryModel,
} from "./model-catalog-discovery";

const EMPTY_OFFERED = {
  anthropic: [],
  google: [],
  mistral: [],
  openai: [],
} as const;

const REVIEWED_REASON = "2026-07-23: property-test disposition";

const provider = fc.constantFrom("anthropic", "google", "mistral", "openai");

const modelId = fc
  .string({ minLength: 1 })
  .filter((value) => !value.includes(":"));

const relevantModel = fc.tuple(provider, modelId).map(
  ([modelProvider, id]): UpstreamDiscoveryModel => ({
    provider: modelProvider,
    modelId: id,
    releaseDate: MODEL_DISCOVERY_EPOCH,
    status: null,
    toolCall: true,
    structuredOutput: true,
    outputModalities: ["text"],
  }),
);

type IneligibleField =
  | "outputModalities"
  | "releaseDate"
  | "status"
  | "structuredOutput"
  | "toolCall";

const makeIneligible = (
  model: UpstreamDiscoveryModel,
  field: IneligibleField,
): UpstreamDiscoveryModel => {
  if (field === "outputModalities") {
    return { ...model, outputModalities: ["text", "audio"] };
  }
  if (field === "releaseDate") {
    return { ...model, releaseDate: "2026-05-31" };
  }
  if (field === "status") {
    return { ...model, status: "deprecated" };
  }
  return { ...model, [field]: false };
};

describe("model catalog discovery invariants", () => {
  test("every relevant unclassified upstream launch fails discovery", () => {
    fc.assert(
      fc.property(relevantModel, (model) => {
        expect(
          findUnreviewedModels({
            upstream: [model],
            offered: EMPTY_OFFERED,
            reviewedExclusions: {},
          }),
        ).toEqual([model]);
      }),
      propertyConfig(),
    );
  });

  test("offering or explicitly reviewing a launch is the only way to clear it", () => {
    fc.assert(
      fc.property(relevantModel, fc.boolean(), (model, offerModel) => {
        const key = `${model.provider}:${model.modelId}`;
        const offered = {
          ...EMPTY_OFFERED,
          [model.provider]: offerModel ? [model.modelId] : [],
        };
        const reviewedExclusions = offerModel
          ? {}
          : ({ [key]: REVIEWED_REASON } as const);

        expect(
          findUnreviewedModels({
            upstream: [model],
            offered,
            reviewedExclusions,
          }),
        ).toEqual([]);
      }),
      propertyConfig(),
    );
  });

  test("missing release dates cannot bypass discovery", () => {
    fc.assert(
      fc.property(relevantModel, (model) => {
        const undatedModel = { ...model, releaseDate: null };

        expect(
          findUnreviewedModels({
            upstream: [undatedModel],
            offered: EMPTY_OFFERED,
            reviewedExclusions: {},
          }),
        ).toEqual([undatedModel]);
      }),
      propertyConfig(),
    );
  });

  test("month-only dates in the discovery epoch cannot bypass discovery", () => {
    fc.assert(
      fc.property(relevantModel, (model) => {
        const monthPrecisionModel = { ...model, releaseDate: "2026-06" };

        expect(
          findUnreviewedModels({
            upstream: [monthPrecisionModel],
            offered: EMPTY_OFFERED,
            reviewedExclusions: {},
          }),
        ).toEqual([monthPrecisionModel]);
      }),
      propertyConfig(),
    );
  });

  test("specialized and unsupported model classes do not create noise", () => {
    fc.assert(
      fc.property(
        relevantModel,
        fc.constantFrom(
          "toolCall",
          "structuredOutput",
          "outputModalities",
          "releaseDate",
          "status",
        ),
        (model, field) => {
          const ineligible = makeIneligible(model, field);
          expect(
            findUnreviewedModels({
              upstream: [ineligible],
              offered: EMPTY_OFFERED,
              reviewedExclusions: {},
            }),
          ).toEqual([]);
        },
      ),
      propertyConfig(),
    );
  });
});
