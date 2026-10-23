import { describe, expect, test } from "bun:test";

import {
  AI_PROVIDERS,
  type AIProvider,
  type ReasoningEffort,
  resolveReasoningEffort,
} from "./index";
import {
  MODEL_DEFAULTS_LEDGER,
  MODEL_TASK_OVERRIDE_GROUP,
  MODEL_TASKS,
  type ModelMode,
  type ModelTask,
  resolveDefaultModel,
} from "./model-defaults-ledger";

const LEGACY_ROLES = ["fast", "chat", "reasoning", "pdf"] as const;
type LegacyRole = (typeof LEGACY_ROLES)[number];

// Captured from the pre-ledger catalog and request defaults. These are the
// migration's behavior contract, not a second runtime source of defaults.
const LEGACY_MODEL_IDS = {
  google: {
    fast: "gemini-3.8-flash",
    chat: "gemini-3.8-flash",
    reasoning: "gemini-3.8-flash",
    pdf: "gemini-3.8-flash",
  },
  openrouter: {
    fast: "openai/gpt-6-luna",
    chat: "openai/gpt-6-sol",
    reasoning: "openai/gpt-6-sol",
    pdf: "openai/gpt-6-sol",
  },
  openai: {
    fast: "gpt-6-luna",
    chat: "gpt-6-sol",
    reasoning: "gpt-6-sol",
    pdf: "gpt-6-sol",
  },
  azure_foundry: {
    fast: "gpt-5.6-luna",
    chat: "gpt-5.6-terra",
    reasoning: "gpt-5.6-terra",
    pdf: "gpt-5.6-terra",
  },
  anthropic: {
    fast: "claude-opus-5-5",
    chat: "claude-opus-5-5",
    reasoning: "claude-opus-5-5",
    pdf: "claude-opus-5-5",
  },
  bedrock: {
    fast: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    chat: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    reasoning: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    pdf: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  mistral: {
    fast: "mistral-small-latest",
    chat: "mistral-medium-latest",
    reasoning: "mistral-medium-latest",
    pdf: null,
  },
  openai_compatible: {
    fast: "default",
    chat: "default",
    reasoning: "default",
    pdf: "default",
  },
  huggingface: {
    fast: "speakleash/Bielik-1.5B-v3.0-Instruct",
    chat: "speakleash/Bielik-11B-v2.3-Instruct",
    reasoning: "speakleash/Bielik-11B-v2.3-Instruct",
    pdf: "speakleash/Bielik-11B-v2.3-Instruct",
  },
} as const satisfies Record<AIProvider, Record<LegacyRole, string | null>>;

const DEFAULT_OMIT = {
  type: "provider-default",
  temperaturePolicy: "omit",
} as const;
const DEFAULT_EMIT = {
  type: "provider-default",
  temperaturePolicy: "emit",
} as const;
const NONE_OMIT = {
  type: "reasoning-effort",
  effort: "none",
  temperaturePolicy: "omit",
} as const;
const HIGH_OMIT = {
  type: "reasoning-effort",
  effort: "high",
  temperaturePolicy: "omit",
} as const;
const GOOGLE_NONE_LOW = {
  type: "google-thinking",
  requestedEffort: "none",
  thinkingLevel: "LOW",
  temperaturePolicy: "omit",
} as const;
const GOOGLE_HIGH_HIGH = {
  type: "google-thinking",
  requestedEffort: "high",
  thinkingLevel: "HIGH",
  temperaturePolicy: "omit",
} as const;
const GOOGLE_THINKING_LEVEL_BY_EFFORT = {
  none: "MINIMAL",
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
} as const satisfies Record<
  ReasoningEffort,
  Extract<ModelMode, { type: "google-thinking" }>["thinkingLevel"]
>;
const LEGACY_MODES = {
  google: {
    fast: GOOGLE_NONE_LOW,
    chat: GOOGLE_NONE_LOW,
    reasoning: GOOGLE_HIGH_HIGH,
    pdf: GOOGLE_NONE_LOW,
  },
  openrouter: {
    fast: NONE_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: HIGH_OMIT,
    pdf: DEFAULT_OMIT,
  },
  openai: {
    fast: DEFAULT_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: {
      type: "reasoning-effort",
      effort: "medium",
      temperaturePolicy: "omit",
    },
    pdf: DEFAULT_OMIT,
  },
  azure_foundry: {
    fast: DEFAULT_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: DEFAULT_OMIT,
    pdf: DEFAULT_OMIT,
  },
  anthropic: {
    fast: DEFAULT_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: {
      type: "anthropic-thinking",
      thinking: { type: "adaptive" },
      temperaturePolicy: "omit",
    },
    pdf: DEFAULT_OMIT,
  },
  bedrock: {
    fast: DEFAULT_EMIT,
    chat: DEFAULT_EMIT,
    reasoning: DEFAULT_EMIT,
    pdf: DEFAULT_EMIT,
  },
  mistral: {
    fast: DEFAULT_EMIT,
    chat: DEFAULT_EMIT,
    reasoning: DEFAULT_EMIT,
    pdf: DEFAULT_EMIT,
  },
  openai_compatible: {
    fast: DEFAULT_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: DEFAULT_OMIT,
    pdf: DEFAULT_OMIT,
  },
  huggingface: {
    fast: DEFAULT_OMIT,
    chat: DEFAULT_OMIT,
    reasoning: DEFAULT_OMIT,
    pdf: DEFAULT_OMIT,
  },
} as const satisfies Record<AIProvider, Record<LegacyRole, ModelMode>>;

const SEED_ROLE_BY_TASK = {
  chat: "chat",
  reasoning: "reasoning",
  analysis: "chat",
  pdf: "pdf",
  "search-expand": "fast",
  classify: "fast",
  "short-text": "fast",
} as const satisfies Record<ModelTask, LegacyRole>;

const FAST_REPLACEMENTS = {
  anthropic: "claude-haiku-5-5",
  bedrock: "us.anthropic.claude-haiku-5-5",
  openrouter: "anthropic/claude-haiku-5.5",
} as const;

describe("task default migration", () => {
  test("covers every provider and task with one documented document exception", () => {
    expect(Object.keys(MODEL_DEFAULTS_LEDGER).toSorted()).toEqual(
      MODEL_TASKS.toSorted(),
    );
    expect(Object.keys(MODEL_TASK_OVERRIDE_GROUP).toSorted()).toEqual(
      MODEL_TASKS.toSorted(),
    );
    const unsupported: string[] = [];
    for (const task of MODEL_TASKS) {
      expect(Object.keys(MODEL_DEFAULTS_LEDGER[task]).toSorted()).toEqual(
        AI_PROVIDERS.toSorted(),
      );
      for (const provider of AI_PROVIDERS) {
        const entry = MODEL_DEFAULTS_LEDGER[task][provider];
        if (entry.kind !== "unsupported") {
          expect(entry.candidate.modelId.length).toBeGreaterThan(0);
          continue;
        }
        expect(entry.reason).toBe("document-input-unsupported");
        unsupported.push(`${task}/${provider}`);
      }
    }
    expect(unsupported).toEqual(["pdf/mistral"]);
  });

  test("preserves the full old model and mode matrix except the three Haiku fast routes", () => {
    for (const task of MODEL_TASKS) {
      const role = SEED_ROLE_BY_TASK[task];
      for (const provider of AI_PROVIDERS) {
        const entry = MODEL_DEFAULTS_LEDGER[task][provider];
        const oldModel = LEGACY_MODEL_IDS[provider][role];
        if (oldModel === null) {
          expect(entry.kind).toBe("unsupported");
          continue;
        }
        if (entry.kind === "unsupported") {
          expect(oldModel).toBeNull();
          continue;
        }
        if (
          role === "fast" &&
          (provider === "anthropic" ||
            provider === "bedrock" ||
            provider === "openrouter")
        ) {
          expect(entry.candidate.modelId).toBe(FAST_REPLACEMENTS[provider]);
          expect(entry.candidate.mode).toEqual(
            provider === "openrouter" ? NONE_OMIT : DEFAULT_OMIT,
          );
          continue;
        }
        expect(entry.candidate.modelId === oldModel).toBe(true);
        expect(entry.candidate.mode).toEqual(LEGACY_MODES[provider][role]);
      }
    }
  });

  test("keeps Gemini seeds unmeasured without provider-bound evidence", () => {
    for (const task of MODEL_TASKS) {
      const entry = MODEL_DEFAULTS_LEDGER[task].google;
      if (task === "reasoning") {
        expect(entry.candidate.mode).toEqual(GOOGLE_HIGH_HIGH);
        continue;
      }
      expect(entry.candidate.mode).toEqual(GOOGLE_NONE_LOW);
      expect(entry.quality).toEqual({
        source: "seed",
        measurement: { status: "unmeasured" },
      });
    }
  });

  test("Google defaults declare the thinking level their current model capability emits", () => {
    for (const task of MODEL_TASKS) {
      const { candidate } = MODEL_DEFAULTS_LEDGER[task].google;
      const effort = resolveReasoningEffort({
        modelId: candidate.modelId,
        requested: candidate.mode.requestedEffort,
      });
      expect(effort).not.toBeNull();
      if (effort === null) {
        continue;
      }
      const resolvedEffort: ReasoningEffort = effort;
      expect(
        candidate.mode.thinkingLevel ===
          GOOGLE_THINKING_LEVEL_BY_EFFORT[resolvedEffort],
      ).toBe(true);
    }
  });
});

describe("ordered task default resolution", () => {
  test("returns null for empty provider configurations and unsupported PDF alone", () => {
    for (const task of MODEL_TASKS) {
      expect(resolveDefaultModel({ task, orgProviders: [] })).toBeNull();
    }
    expect(
      resolveDefaultModel({ task: "pdf", orgProviders: ["mistral"] }),
    ).toBeNull();
  });

  test("uses the first supported provider for every ordered pair and full-list rotation", () => {
    const orders: AIProvider[][] = [];
    for (const first of AI_PROVIDERS) {
      for (const second of AI_PROVIDERS) {
        orders.push([first, second]);
      }
    }
    for (const [index] of AI_PROVIDERS.entries()) {
      const rotation = [
        ...AI_PROVIDERS.slice(index),
        ...AI_PROVIDERS.slice(0, index),
      ];
      orders.push(rotation, rotation.toReversed());
    }
    for (const task of MODEL_TASKS) {
      for (const orgProviders of orders) {
        const expectedProvider = orgProviders.find(
          (provider) =>
            MODEL_DEFAULTS_LEDGER[task][provider].kind === "candidate",
        );
        const actual = resolveDefaultModel({ task, orgProviders });
        if (expectedProvider === undefined) {
          expect(actual).toBeNull();
          continue;
        }
        const entry = MODEL_DEFAULTS_LEDGER[task][expectedProvider];
        if (entry.kind === "unsupported") {
          throw new TypeError("Selected provider must support the task");
        }
        expect(actual).toEqual({
          provider: expectedProvider,
          ...entry.candidate,
        });
      }
    }
  });
});
