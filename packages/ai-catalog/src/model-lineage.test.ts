import { describe, expect, test } from "bun:test";

import { MODEL_DISPLAY_METADATA, RECOMMENDED_CHAT_MODELS } from "./index";
import type { ModelDisplayMetadata } from "./index";

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

const newerInLine = (displayName: string, iconProvider: string) => {
  const own = lineOf(displayName);
  if (own === null) {
    return [];
  }
  return models.filter(([, candidate]) => {
    const other = lineOf(candidate.displayName);
    return (
      candidate.iconProvider === iconProvider &&
      other?.line === own.line &&
      other.version > own.version
    );
  });
};

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
        newerInLine(model.displayName, model.iconProvider).length > 0
      );
    });
    expect(stale).toEqual([]);
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
