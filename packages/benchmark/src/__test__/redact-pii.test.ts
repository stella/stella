import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { createRedactPiiAdapter } from "../adapters/redact-pii";
import { loadGroundTruth } from "../ground-truth";

type StablePrediction = readonly [
  string,
  readonly {
    readonly start: number;
    readonly end: number;
    readonly label: string;
    readonly text: string;
  }[],
];

describe("redact-pii benchmark adapter", () => {
  test("preserves the pinned 3.4.0 predictions", async () => {
    const adapter = createRedactPiiAdapter();
    const outcome = await adapter.run(await loadGroundTruth());

    expect(adapter.version).toBe("3.4.0");
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

    expect({
      digest,
      documentCount: predictions.length,
      spanCount,
    }).toMatchSnapshot();
  });
});
