import { describe, expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  MODEL_DISPLAY_METADATA,
  RECOMMENDED_CHAT_MODELS,
} from "./index";
import type { BYOKProvider, ModelDisplayMetadata } from "./index";
import { MODEL_DEFAULTS_LEDGER, MODEL_TASKS } from "./model-defaults-ledger";

const models: [string, ModelDisplayMetadata][] = Object.entries(
  MODEL_DISPLAY_METADATA,
);

/**
 * "Claude Opus 5.5" -> line "Claude Opus", version 5.5; "GPT-6 Luna" -> line
 * "GPT Luna", version 6. A number glued to a unit ("GPT OSS 120B") is a size,
 * not a version, so such names have no line.
 */
const lineOf = (displayName: string) => {
  const match = /^(.*?)[ -](\d+(?:\.\d+)?)(?= |$)(.*)$/u.exec(displayName);
  if (match === null) {
    return null;
  }
  const [, before = "", version = "", after = ""] = match;
  return { line: `${before}${after}`, version: Number(version) };
};

const newerInLine = (
  displayName: string,
  iconProvider: string,
  pool: readonly [string, ModelDisplayMetadata][] = models,
) => {
  const own = lineOf(displayName);
  if (own === null) {
    return [];
  }
  return pool.filter(([, candidate]) => {
    const other = lineOf(candidate.displayName);
    return (
      candidate.iconProvider === iconProvider &&
      other?.line === own.line &&
      other.version > own.version
    );
  });
};

/**
 * A maker can start a new generation under new line names (Gemini 3.8 Flash
 * was followed by Gemini 4 Hydrogen, Neon, Carbon and Argon), so "newest of
 * its line" alone lets a default fall a whole generation behind.
 */
const behindMakerGeneration = (
  model: ModelDisplayMetadata,
  pool: readonly [string, ModelDisplayMetadata][] = models,
) => {
  const own = lineOf(model.displayName);
  if (own === null) {
    return false;
  }
  const newestMajor = Math.max(
    ...pool
      .filter(([, candidate]) => candidate.iconProvider === model.iconProvider)
      .map(([, candidate]) => lineOf(candidate.displayName)?.version ?? 0)
      .map(Math.floor),
  );
  return Math.floor(own.version) < newestMajor;
};

/** Defaults that may stay behind, each with the reason. */
const REVIEWED_STALE_DEFAULTS: ReadonlyMap<string, string> = new Map([
  [
    "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "Bedrock offers no newer Sonnet or Opus model yet.",
  ],
]);

const isOfferedProvider = (provider: string): provider is BYOKProvider =>
  Object.hasOwn(BYOK_MODEL_OPTIONS, provider);
const BYOK_PROVIDERS =
  Object.keys(BYOK_MODEL_OPTIONS).filter(isOfferedProvider);

const offeredPool = (provider: BYOKProvider) => {
  const offered: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return models.filter(([id]) => offered.includes(id));
};

const staleLedgerDefaults = () =>
  MODEL_TASKS.flatMap((task) =>
    BYOK_PROVIDERS.flatMap((provider) => {
      const entry = MODEL_DEFAULTS_LEDGER[task][provider];
      if (entry.kind !== "candidate") {
        return [];
      }
      const modelId: string = entry.candidate.modelId;
      const model = models.find(([id]) => id === modelId)?.[1];
      if (model === undefined) {
        return [`${task}/${provider}: ${modelId} is not offered`];
      }
      if (REVIEWED_STALE_DEFAULTS.has(`${provider}:${modelId}`)) {
        return [];
      }
      const pool = offeredPool(provider);
      return model.supersededBy !== undefined ||
        newerInLine(model.displayName, model.iconProvider, pool).length > 0 ||
        behindMakerGeneration(model, pool)
        ? [`${task}/${provider}: ${modelId}`]
        : [];
    }),
  );

describe("model lineage", () => {
  test("every model with a newer model of its line names a successor", () => {
    const missing = models
      .filter(
        ([, model]) =>
          model.supersededBy === undefined &&
          newerInLine(model.displayName, model.iconProvider).length > 0,
      )
      .map(([value]) => value);
    expect(missing).toEqual([]);
  });

  test("a successor is an offered, newer, current model of the same maker", () => {
    for (const [value, model] of models) {
      if (model.supersededBy === undefined) {
        continue;
      }
      const successor = models.find(([id]) => id === model.supersededBy)?.[1];
      expect({ value, successor: successor?.displayName }).toEqual({
        value,
        successor: expect.any(String),
      });
      if (successor === undefined) {
        continue;
      }
      expect({ value, maker: successor.iconProvider }).toEqual({
        value,
        maker: model.iconProvider,
      });
      expect({ value, successorIsCurrent: successor.supersededBy }).toEqual({
        value,
        successorIsCurrent: undefined,
      });
      const own = lineOf(model.displayName);
      const next = lineOf(successor.displayName);
      if (own !== null && next !== null && own.line === next.line) {
        expect({ value, newer: next.version > own.version }).toEqual({
          value,
          newer: true,
        });
      }
    }
  });

  test("no curated model is superseded or has a newer model of its line", () => {
    const stale = RECOMMENDED_CHAT_MODELS.filter((modelId) => {
      const model: ModelDisplayMetadata = MODEL_DISPLAY_METADATA[modelId];
      return (
        model.supersededBy !== undefined ||
        newerInLine(model.displayName, model.iconProvider).length > 0 ||
        behindMakerGeneration(model)
      );
    });
    expect(stale).toEqual([]);
  });

  test("every default is the newest generation its provider offers", () => {
    expect(staleLedgerDefaults()).toEqual([]);
  });

  test("a default a generation behind its maker fails", () => {
    expect(
      behindMakerGeneration(MODEL_DISPLAY_METADATA["gemini-3.8-flash"]),
    ).toBe(true);
    expect(
      behindMakerGeneration(MODEL_DISPLAY_METADATA["gemini-4-hydrogen"]),
    ).toBe(false);
  });

  test("every reviewed stale default is still a default", () => {
    const defaults = new Set(
      MODEL_TASKS.flatMap((task) =>
        Object.entries(MODEL_DEFAULTS_LEDGER[task]).map(([provider, entry]) =>
          entry.kind === "candidate"
            ? `${provider}:${entry.candidate.modelId}`
            : "",
        ),
      ),
    );
    expect(
      [...REVIEWED_STALE_DEFAULTS.keys()].filter((key) => !defaults.has(key)),
    ).toEqual([]);
  });

  test("the curated list names each product once", () => {
    const products = RECOMMENDED_CHAT_MODELS.map(
      (modelId) => MODEL_DISPLAY_METADATA[modelId].displayName,
    );
    expect(new Set(products).size).toBe(products.length);
  });

  test("the line parser reads versions and ignores sizes", () => {
    expect(lineOf("Claude Opus 5.5")).toEqual({
      line: "Claude Opus",
      version: 5.5,
    });
    expect(lineOf("GPT-6 Luna")).toEqual({ line: "GPT Luna", version: 6 });
    expect(lineOf("Gemini 3.5 Flash Lite")).toEqual({
      line: "Gemini Flash Lite",
      version: 3.5,
    });
    expect(lineOf("GPT OSS 120B")).toBeNull();
    expect(lineOf("Mistral Large")).toBeNull();
  });
});
