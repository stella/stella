import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { createBenchmarkAdapters } from "../adapters";
import {
  createOpenRedactionAdapter,
  createStatelessOpenRedaction,
} from "../adapters/openredaction";
import { loadGroundTruth } from "../ground-truth";
import { OPENREDACTION_MAPPING, supportedLabels } from "../taxonomy";

const EXPECTED_PREDICTION_DIGEST =
  "b7f05e0a2aadcb1d76faaabbe5c26a5e35a64045f16c4bc17c3560a57daa44ff";

type StablePrediction = readonly [
  string,
  readonly {
    readonly start: number;
    readonly end: number;
    readonly label: string;
    readonly text: string;
  }[],
];

describe("OpenRedaction benchmark adapter", () => {
  test("disables the working-directory learning store", async () => {
    const { OpenRedaction } = await import("@openredaction/core");
    const detector = createStatelessOpenRedaction(OpenRedaction);

    expect(detector.getLearningStore()).toBeUndefined();
    expect(detector.getLearningStats()).toBeNull();
  });

  test("is registered in every sealed runner", () => {
    const adapter = createBenchmarkAdapters().find(
      ({ name }) => name === "openredaction",
    );

    expect(adapter?.version).toBe("1.1.5");
  });

  test("maps the default engine's common-taxonomy labels", () => {
    expect([...supportedLabels(OPENREDACTION_MAPPING)].sort()).toEqual([
      "address",
      "date",
      "email",
      "id-number",
      "person",
      "phone",
    ]);
    expect(OPENREDACTION_MAPPING["NAME"]).toBe("person");
    expect(OPENREDACTION_MAPPING["ADDRESS_STREET"]).toBe("address");
    expect(OPENREDACTION_MAPPING["IBAN"]).toBe("id-number");
    expect(OPENREDACTION_MAPPING["USERNAME"]).toBeNull();
    expect(OPENREDACTION_MAPPING["ORGANIZATION"]).toBeUndefined();
  });

  test("preserves the pinned 1.1.5 predictions", async () => {
    const outcome = await createOpenRedactionAdapter().run(
      await loadGroundTruth(),
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    const predictions: StablePrediction[] = [...outcome.predictions].map(
      ([id, spans]) => [
        id,
        spans.map(({ start, end, label, text }) => ({
          start,
          end,
          label,
          text,
        })),
      ],
    );
    const spanCount = predictions.reduce(
      (sum, [, spans]) => sum + spans.length,
      0,
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(predictions))
      .digest("hex");

    expect(predictions).toHaveLength(28);
    expect(spanCount).toBe(199);
    expect(digest).toBe(EXPECTED_PREDICTION_DIGEST);
    const emittedLabels = new Set(
      predictions.flatMap(([, spans]) => spans.map(({ label }) => label)),
    );
    expect(
      [...emittedLabels].filter(
        (label) => !Object.hasOwn(OPENREDACTION_MAPPING, label),
      ),
    ).toEqual([]);
  });
});
