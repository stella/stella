import { describe, expect, test } from "bun:test";

import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { toSafeId } from "@/api/lib/branded-types";
import { analysisFailureRecord } from "@/api/lib/case-law/analysis-failure";
import type { AnalysisStore } from "@/api/lib/case-law/analysis-store";
import { createMemoryAnalysisStore } from "@/api/lib/case-law/analysis-store";
import { ModelOutputInvalidError } from "@/api/lib/errors/provider-call-error";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { TanStackStructuredOutputEvent } from "@/api/lib/tanstack-ai-generate";

import type { AnalysisOutput } from "./analysis-output";
import { runGeneration } from "./generate";

type AnalysisHeadingInput = AnalysisOutput["headings"][number];

const decisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000a1",
);
const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-0000000000b1",
);
const fingerprint = "f".repeat(64);
const heading = (label: string, anchor: string): AnalysisHeadingInput => ({
  id: "model-id",
  label,
  category: "reasoning",
  startAnchorId: anchor,
  endAnchorId: anchor,
  annotations: [],
});
const first = heading("First", "b1");
const second = heading("Second", "b2");
const draft = heading("Draft", "b3");
const invalid = { label: "Invalid" };
const output = (): AnalysisOutput => ({
  headings: [first, second],
  holding: [{ text: "A legal rule.", anchors: [] }],
  abstract: [{ text: "A useful summary of the decision.", anchors: [] }],
  topics: ["procedure"],
});
const partial = (
  headings: (AnalysisHeadingInput | typeof invalid)[],
): TanStackStructuredOutputEvent<AnalysisOutput> => ({
  type: "partial",
  delta: "",
  raw: "",
  partial: { headings },
});
const complete = (): TanStackStructuredOutputEvent<AnalysisOutput> => ({
  type: "complete",
  object: output(),
  raw: "",
});

const setup = async () => {
  const store = createMemoryAnalysisStore(
    () => new Date("2026-10-18T12:00:00.000Z"),
  );
  const sentinel = await store.claim({
    decisionId,
    fingerprint,
    observed: null,
  });
  if (sentinel === null) {
    throw new Error("expected the run to claim the decision");
  }
  return { sentinel, store };
};
type Overrides = Partial<
  Pick<
    Parameters<typeof runGeneration>[0],
    "generateAnalysisObject" | "nowMs" | "streamAnalysis"
  >
>;
const run = async (
  store: AnalysisStore,
  sentinel: NonNullable<Awaited<ReturnType<AnalysisStore["claim"]>>>,
  overrides: Overrides,
) =>
  await runGeneration({
    admission: admitFixtureModelDispatch({
      userId: null,
      organizationId,
      actionKind: "case-law.analysis",
      modelTier: "standard",
    }),
    anchorIds: ["b1", "b2", "b3"],
    contentHash: null,
    country: "CZ",
    deadlineMs: 10_000,
    decisionId,
    input: {
      language: "en",
      systemPrompt: "Analyze.",
      userMessage: "Decision",
      fingerprint,
    },
    orgAIConfig: null,
    organizationId,
    promptCachingEnabled: false,
    reader: { source: "platform" },
    resolveTextModel: undefined,
    streamAnalysis: undefined,
    generateAnalysisObject: undefined,
    resolveModelInfo: () => ({ modelId: "test-model" }),
    nowMs: () => 0,
    sentinel,
    store,
    ...overrides,
  });

const recordingStore = (
  store: AnalysisStore,
  writes: string[][],
): AnalysisStore => ({
  ...store,
  savePartial: async (options) => {
    writes.push(options.partialTree.map(({ label }) => label));
    return await store.savePartial(options);
  },
});

describe("streamed case-law analysis generation", () => {
  test("publishes valid sections in order while skipping an invalid heading", async () => {
    const { sentinel, store } = await setup();
    const writes: string[][] = [];
    let now = 0;
    await run(recordingStore(store, writes), sentinel, {
      nowMs: () => now,
      async *streamAnalysis() {
        yield partial([first, draft]);
        now = 1000;
        yield partial([first, invalid, draft]);
        now = 2000;
        yield partial([first, invalid, second, draft]);
        yield complete();
      },
    });
    expect(writes).toEqual([["First"], ["First", "Second"]]);
  });

  test("publishes sections completed inside the interval on the next event past it", async () => {
    const { sentinel, store } = await setup();
    const operations: string[] = [];
    const observed: AnalysisStore = {
      ...store,
      savePartial: async (options) => {
        operations.push(
          `partial:${options.partialTree.map(({ label }) => label).join(",")}`,
        );
        return await store.savePartial(options);
      },
      save: async (options) => {
        operations.push("final");
        return await store.save(options);
      },
    };
    let now = 0;
    await run(observed, sentinel, {
      nowMs: () => now,
      async *streamAnalysis() {
        yield partial([first, draft]);
        now = 100;
        yield partial([first, second, draft]);
        now = 1000;
        yield partial([first, second, draft]);
        yield complete();
      },
    });
    expect(operations).toEqual([
      "partial:First",
      "partial:First,Second",
      "final",
    ]);
  });

  test("does not expose sections appended inside the publication interval", async () => {
    const { sentinel, store } = await setup();
    let now = 0;
    await run(store, sentinel, {
      nowMs: () => now,
      async *streamAnalysis() {
        yield partial([first, draft]);
        now = 100;
        yield partial([first, second, draft]);
        expect(store.peek(decisionId)).toMatchObject({
          partialTree: [{ label: "First" }],
        });
        yield complete();
      },
    });
  });

  test("a superseded run cannot write, clear, or fail its replacement", async () => {
    const { sentinel: superseded, store } = await setup();
    const replacement = await store.claim({
      decisionId,
      fingerprint,
      observed: store.peek(decisionId),
    });
    if (replacement === null) {
      throw new Error("expected a replacement run to claim the decision");
    }
    expect(replacement.startedAt).toBe(superseded.startedAt);
    expect(replacement.runId).not.toBe(superseded.runId);

    const replacementTree = [{ ...first, children: [] }];
    expect(
      await store.savePartial({
        decisionId,
        partialTree: replacementTree,
        sentinel: replacement,
      }),
    ).toBe(true);
    const held = store.peek(decisionId);

    expect(
      await store.savePartial({
        decisionId,
        partialTree: [{ ...second, children: [] }],
        sentinel: superseded,
      }),
    ).toBe(false);
    expect(store.peek(decisionId)).toEqual(held);

    await run(store, superseded, {
      async *streamAnalysis() {
        yield complete();
      },
    });
    expect(store.peek(decisionId)).toEqual(held);

    await store.clear({ decisionId, sentinel: superseded });
    expect(store.peek(decisionId)).toEqual(held);

    await store.fail({
      decisionId,
      keyTag: "platform",
      sentinel: superseded,
      failure: analysisFailureRecord({
        code: "failed",
        fingerprint,
        now: new Date("2026-10-18T12:00:00.000Z"),
        reader: { source: "platform" },
      }),
    });
    expect(store.peek(decisionId)).toEqual(held);
    expect(
      await store.readFailure({ decisionId, keyTag: "platform" }),
    ).toBeNull();

    await run(store, replacement, {
      async *streamAnalysis() {
        yield complete();
      },
    });
    expect(store.peek(decisionId)).toMatchObject({
      version: 4,
      tree: [{ label: "First" }, { label: "Second" }],
    });
    expect(store.peek(decisionId)).not.toHaveProperty("status");
  });

  test("paces refused writes from a superseded run", async () => {
    const { sentinel, store } = await setup();
    expect(
      await store.claim({
        decisionId,
        fingerprint,
        observed: store.peek(decisionId),
      }),
    ).not.toBeNull();
    const attempts: number[] = [];
    let now = 0;
    const observed: AnalysisStore = {
      ...store,
      savePartial: async (options) => {
        attempts.push(now);
        return await store.savePartial(options);
      },
    };
    await run(observed, sentinel, {
      nowMs: () => now,
      async *streamAnalysis() {
        yield partial([first, draft]);
        now = 100;
        yield partial([first, second, draft]);
        now = 999;
        yield partial([first, second, draft]);
        now = 1000;
        yield partial([first, second, draft]);
        yield complete();
      },
    });
    expect(attempts).toEqual([0, 1000]);
  });

  test("replaces the partial tree with the final done analysis", async () => {
    const { sentinel, store } = await setup();
    await run(store, sentinel, {
      async *streamAnalysis() {
        yield partial([first, draft]);
        yield complete();
      },
    });
    expect(store.peek(decisionId)).toMatchObject({
      version: 4,
      inputFingerprint: fingerprint,
      tree: [{ label: "First" }, { label: "Second" }],
    });
    expect(store.peek(decisionId)).not.toHaveProperty("partialTree");
    expect(store.peek(decisionId)).not.toHaveProperty("status");
  });

  test("a revision compares the observed value rather than parser object identity", async () => {
    const { sentinel, store } = await setup();
    await run(store, sentinel, {
      async *streamAnalysis() {
        yield complete();
      },
    });
    const observed = parsePersistedDecisionAnalysis(store.peek(decisionId));
    if (observed === null || "status" in observed) {
      throw new Error("expected a completed analysis");
    }
    const revision = { ...observed, model: "revised" };
    expect(
      await store.save({
        analysis: revision,
        contentHash: null,
        decisionId,
        ownership: { type: "revision", expected: observed },
      }),
    ).toBe(true);
    expect(
      await store.save({
        analysis: { ...observed, model: "stale" },
        contentHash: null,
        decisionId,
        ownership: { type: "revision", expected: observed },
      }),
    ).toBe(false);
    expect(store.peek(decisionId)).toEqual(revision);
  });

  test("gives an invalid-stream fallback only the remaining deadline", async () => {
    const { sentinel, store } = await setup();
    let now = 2000;
    const deadlines: number[] = [];
    await run(store, sentinel, {
      nowMs: () => now,
      async *streamAnalysis() {
        now = 3250;
        throw new ModelOutputInvalidError({
          model: { provider: "openai", keySource: "instance" },
        });
      },
      generateAnalysisObject: async ({ deadlineMs }) => {
        deadlines.push(deadlineMs);
        return output();
      },
    });
    expect(deadlines).toEqual([8750]);
  });
});
