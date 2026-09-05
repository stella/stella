import { isValidElement } from "react";

import { describe, expect, test } from "bun:test";

import { ReviewAlignedPair } from "@/components/ai-suggestions/review-aligned-pair";
import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import { ReviewDeltaView } from "@/components/ai-suggestions/review-delta-view";
import { ReviewPresenceMatrix } from "@/components/ai-suggestions/review-presence-matrix";
import { ReviewTermTable } from "@/components/ai-suggestions/review-term-row";

// apps/web has no @testing-library/react dependency (no other *.test.tsx
// under components/ai-suggestions renders into a DOM either), so this
// verifies dispatch by calling the component function directly and
// inspecting the returned element tree rather than mounting it.

const side = { label: "Target", passages: [] };

const readProp = (node: unknown, key: string): unknown => {
  if (!isValidElement(node)) {
    return undefined;
  }
  const props: unknown = node.props;
  if (typeof props !== "object" || props === null || !(key in props)) {
    return undefined;
  }
  return Reflect.get(props, key);
};

/** The child elements the returned element renders, in render order. */
const childElements = (node: unknown) => {
  const children = readProp(node, "children");
  return (Array.isArray(children) ? children : [children]).filter(
    isValidElement,
  );
};

/** The component types the returned element renders, in render order. */
const childTypes = (node: unknown): unknown[] =>
  childElements(node).map((child) => child.type);

describe("review delta view dispatch", () => {
  test("a parameter delta shows the term table above the passages", () => {
    const delta: ReviewDelta = {
      kind: "parameter",
      standard: null,
      target: null,
    };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Notice period",
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([ReviewTermTable, ReviewAlignedPair]);
  });

  // The delta names the exact phrase that differs, which is what the pair
  // marks with its strongest highlight.
  test("a parameter delta reaches the pair", () => {
    const delta: ReviewDelta = {
      kind: "parameter",
      standard: null,
      target: null,
    };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Notice period",
      standard: side,
      target: side,
    });
    const pair = childElements(element).find(
      (child) => child.type === ReviewAlignedPair,
    );
    expect(readProp(pair, "delta")).toBe(delta);
  });

  // The matrix answers "which limbs", the pair answers "in what words". The
  // second question used to have no answer at all for these two kinds.
  test("an enumeration delta keeps the passages under the matrix", () => {
    const delta: ReviewDelta = { items: [], kind: "enumeration" };
    const element = ReviewDeltaView({
      delta,
      impact: "neutral",
      label: "Leakage definition",
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([
      ReviewPresenceMatrix,
      ReviewAlignedPair,
    ]);
  });

  test("a presence delta keeps the passages under the matrix", () => {
    const delta: ReviewDelta = {
      inStandard: true,
      inTarget: false,
      kind: "presence",
      term: "Losses",
    };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Losses",
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([
      ReviewPresenceMatrix,
      ReviewAlignedPair,
    ]);
  });

  test("a language delta is the aligned pair alone, with no delta to mark", () => {
    const delta: ReviewDelta = { kind: "language" };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Fairly Disclosed",
      standard: side,
      target: side,
    });
    expect(element.type).toBe(ReviewAlignedPair);
    expect(readProp(element, "delta")).toBeUndefined();
  });

  test("the reference name overrides the standard column label", () => {
    const element = ReviewDeltaView({
      delta: { kind: "language" },
      impact: "neutral",
      label: "Governing law",
      standard: side,
      standardLabel: "Standard (Master NDA)",
      target: side,
    });
    expect(readProp(element, "standardLabel")).toBe("Standard (Master NDA)");
  });
});
