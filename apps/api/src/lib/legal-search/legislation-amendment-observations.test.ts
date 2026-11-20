import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { legislationAmendmentEffectSchema } from "./legislation-amendment-effect";
import type { LegislationAmendmentEffect } from "./legislation-amendment-effect";
import { resolveLegislationAmendmentEffect } from "./legislation-amendment-observations";
import type { LegislationAmendmentChannelObservation } from "./legislation-ingestion-types";

const conditional = {
  type: "conditional",
  condition: {
    text: "When the implementing rule takes effect",
    label: "Implementing rule",
  },
  workingDate: "2999-01-01",
  actualDate: null,
} satisfies LegislationAmendmentEffect;
const observation = (
  effective: LegislationAmendmentEffect,
  channel: string,
): LegislationAmendmentChannelObservation => ({
  channel,
  status: "present",
  observedAt: "2026-10-20T10:00:00Z",
  relation: {
    publisherId: "publisher:effect-1",
    amendingEli: "https://example.test/acts/2026/101",
    amendingTitle: null,
    amendingAnchor: null,
    affectedAnchor: "section-5",
    changeKind: "repealed",
    effective,
    publisherInstruction: null,
  },
});

test("publisher effect schema accepts conditions without turning working dates into actual dates", () => {
  expect(v.parse(legislationAmendmentEffectSchema, conditional)).toEqual(
    conditional,
  );
  for (const effective of [
    { ...conditional, actualDate: "2027-02-30" },
    { ...conditional, condition: { text: "\u0000 ", label: null } },
    { type: "conflicting" },
  ]) {
    expect(
      v.safeParse(legislationAmendmentEffectSchema, effective).success,
    ).toBe(false);
  }
});

test("condition evidence is retained when another channel reports its working date", () => {
  expect(
    resolveLegislationAmendmentEffect([
      observation(conditional, "bulk"),
      observation({ type: "date", on: conditional.workingDate }, "incremental"),
    ]),
  ).toEqual(conditional);
});

test("conditions explain both working and actual dates regardless of channel order", () => {
  const resolved = { ...conditional, actualDate: "2027-04-01" };
  expect(
    resolveLegislationAmendmentEffect([
      observation({ type: "date", on: conditional.workingDate }, "a"),
      observation({ type: "date", on: "2027-04-01" }, "b"),
      observation(resolved, "z"),
    ]),
  ).toEqual(resolved);
});

test("incompatible publisher claims stay explicitly conflicting", () => {
  expect(
    resolveLegislationAmendmentEffect([
      observation(conditional, "bulk"),
      observation({ type: "date", on: "2028-01-01" }, "incremental"),
    ]),
  ).toEqual({ type: "conflicting" });
});

test("effect resolution is invariant under observation permutations and duplicate evidence", async () => {
  await assertProperty(
    "legislation amendment channel effect order",
    fc.property(
      fc.array(
        fc.constantFrom(
          ...([
            conditional,
            { type: "date", on: "2999-01-01" },
            { type: "date", on: "2028-01-01" },
            { type: "not-stated", text: null },
          ] as const satisfies readonly LegislationAmendmentEffect[]),
        ),
        { minLength: 1, maxLength: 8 },
      ),
      (effects) => {
        const observations = effects.map((effect, index) =>
          observation(effect, String(index)),
        );
        const resolved = resolveLegislationAmendmentEffect(observations);
        expect(
          resolveLegislationAmendmentEffect(observations.toReversed()),
        ).toEqual(resolved);
        expect(
          resolveLegislationAmendmentEffect([...observations, ...observations]),
        ).toEqual(resolved);
      },
    ),
  );
});
