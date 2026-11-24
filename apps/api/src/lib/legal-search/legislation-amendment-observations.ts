import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import type { LegislationAmendmentEffect } from "./legislation-amendment-effect";
import type {
  LegislationAmendmentChannelObservation,
  LegislationAmendmentPositiveEvidence,
  LegislationAmendmentResolvedEffect,
} from "./legislation-ingestion-types";

export const LEGISLATION_AMENDMENT_LEGACY_CHANNEL = "legacy";
export const LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES = 64;
export const LEGISLATION_AMENDMENT_CHANNEL_LIMIT = 8;

const conflicting = { type: "conflicting" } as const;
const effectOrder = {
  conditional: 0,
  date: 1,
  "not-stated": 2,
} as const satisfies Record<LegislationAmendmentEffect["type"], number>;

const mergeDate = (
  conditional: Extract<LegislationAmendmentEffect, { type: "conditional" }>,
  date: Extract<LegislationAmendmentEffect, { type: "date" }>,
): LegislationAmendmentResolvedEffect =>
  date.on === conditional.actualDate || date.on === conditional.workingDate
    ? conditional
    : conflicting;

const mergeCondition = (
  left: Extract<LegislationAmendmentEffect, { type: "conditional" }>,
  right: Extract<LegislationAmendmentEffect, { type: "conditional" }>,
): LegislationAmendmentResolvedEffect => {
  if (
    left.condition.text !== right.condition.text ||
    (left.condition.label !== null &&
      right.condition.label !== null &&
      left.condition.label !== right.condition.label) ||
    (left.workingDate !== null &&
      right.workingDate !== null &&
      left.workingDate !== right.workingDate) ||
    (left.actualDate !== null &&
      right.actualDate !== null &&
      left.actualDate !== right.actualDate)
  ) {
    return conflicting;
  }
  return {
    type: "conditional",
    condition: {
      text: left.condition.text,
      label: left.condition.label ?? right.condition.label,
    },
    workingDate: left.workingDate ?? right.workingDate,
    actualDate: left.actualDate ?? right.actualDate,
  };
};

const mergeEffect = (
  left: LegislationAmendmentResolvedEffect,
  right: LegislationAmendmentEffect,
): LegislationAmendmentResolvedEffect => {
  switch (left.type) {
    case "conflicting":
      return left;
    case "not-stated":
      if (left.text === null) {
        return right;
      }
      switch (right.type) {
        case "not-stated":
          return right.text === null || right.text === left.text
            ? left
            : conflicting;
        case "conditional":
          return left.text === right.condition.text ? right : conflicting;
        case "date":
          return conflicting;
        default:
          right satisfies never;
          return panic("Unhandled amendment effect");
      }
    case "date":
      switch (right.type) {
        case "date":
          return left.on === right.on ? left : conflicting;
        case "conditional":
          return mergeDate(right, left);
        case "not-stated":
          return right.text === null ? left : conflicting;
        default:
          right satisfies never;
          return panic("Unhandled amendment effect");
      }
    case "conditional":
      switch (right.type) {
        case "date":
          return mergeDate(left, right);
        case "conditional":
          return mergeCondition(left, right);
        case "not-stated":
          return right.text === null || right.text === left.condition.text
            ? left
            : conflicting;
        default:
          right satisfies never;
          return panic("Unhandled amendment effect");
      }
    default:
      left satisfies never;
      return panic("Unhandled resolved amendment effect");
  }
};

const fillConditionalFields = (
  latest: Extract<LegislationAmendmentEffect, { type: "conditional" }>,
  retained: Extract<LegislationAmendmentEffect, { type: "conditional" }>,
) =>
  ({
    type: "conditional",
    condition: {
      text: latest.condition.text,
      label: latest.condition.label ?? retained.condition.label,
    },
    workingDate: latest.workingDate ?? retained.workingDate,
    actualDate: latest.actualDate ?? retained.actualDate,
  }) as const;

/** Latest non-null fields of one condition; the raw observation remains separate. */
const conditionalProjection = (
  previous: LegislationAmendmentPositiveEvidence,
) => {
  const retained = previous.retainedConditional;
  if (
    retained !== undefined &&
    retained.relation.effective.type !== "conditional"
  ) {
    return panic("Retained amendment projection must be conditional");
  }
  const latest = previous.relation.effective;
  if (latest.type !== "conditional") {
    return retained;
  }
  const effective = retained?.relation.effective;
  return {
    observedAt: previous.observedAt,
    relation: {
      ...previous.relation,
      effective:
        effective?.type === "conditional" &&
        effective.condition.text === latest.condition.text
          ? fillConditionalFields(latest, effective)
          : latest,
    },
  };
};

/** Missing fields or bare dates cannot establish that a condition ended. */
export const retainLegislationAmendmentCondition = (
  previous: LegislationAmendmentPositiveEvidence | undefined,
  relation: LegislationAmendmentPositiveEvidence["relation"],
): LegislationAmendmentPositiveEvidence["retainedConditional"] => {
  if (previous === undefined) {
    return undefined;
  }
  const rich = conditionalProjection(previous);
  if (rich === undefined) {
    return undefined;
  }
  const prior = rich.relation.effective;
  if (prior.type !== "conditional") {
    return panic("Retained amendment projection must be conditional");
  }
  switch (relation.effective.type) {
    case "conditional": {
      const latest = relation.effective;
      if (latest.condition.text !== prior.condition.text) {
        return undefined;
      }
      return (latest.condition.label === null &&
        prior.condition.label !== null) ||
        (latest.workingDate === null && prior.workingDate !== null) ||
        (latest.actualDate === null && prior.actualDate !== null)
        ? rich
        : undefined;
    }
    case "not-stated":
    case "date":
      return rich;
    default:
      relation.effective satisfies never;
      return panic("Unhandled amendment effect");
  }
};

/** A condition explains a working date; incompatible claims remain explicit. */
export const resolveLegislationAmendmentEffect = (
  observations: readonly LegislationAmendmentChannelObservation[],
): LegislationAmendmentResolvedEffect => {
  if (observations.some((item) => item.status === "absent")) {
    return conflicting;
  }
  const positive = observations.flatMap((item) => {
    if (item.status === "absent") {
      return [];
    }
    if (item.retainedConditional === undefined) {
      return [item];
    }
    if (item.relation.effective.type === "conditional") {
      const projection =
        conditionalProjection(item) ??
        panic("Conditional contribution needs a projection");
      return [
        {
          ...item,
          relation: projection.relation,
          retainedConditional: undefined,
        },
      ];
    }
    return [
      item,
      {
        status: item.status,
        channel: item.channel,
        ...item.retainedConditional,
        retainedConditional: undefined,
      },
    ];
  });
  const first =
    positive.at(0)?.relation ??
    panic("An amendment resolution needs a publisher contribution");
  const anchors = new Set(
    positive.flatMap(({ relation }) =>
      relation.amendingAnchor === null ? [] : [relation.amendingAnchor],
    ),
  );
  const instructions = new Set(
    positive.flatMap(({ relation }) =>
      relation.publisherInstruction === null
        ? []
        : [relation.publisherInstruction],
    ),
  );
  if (
    anchors.size > 1 ||
    instructions.size > 1 ||
    positive.some(
      ({ relation }) =>
        relation.publisherId !== first.publisherId ||
        relation.amendingEli !== first.amendingEli ||
        relation.affectedAnchor !== first.affectedAnchor ||
        relation.changeKind !== first.changeKind,
    )
  ) {
    return conflicting;
  }
  let effect: LegislationAmendmentResolvedEffect = {
    type: "not-stated",
    text: null,
  };
  for (const observation of positive.toSorted(
    (left, right) =>
      effectOrder[left.relation.effective.type] -
        effectOrder[right.relation.effective.type] ||
      compareCodeUnit(left.channel, right.channel),
  )) {
    effect = mergeEffect(effect, observation.relation.effective);
  }
  return effect;
};
