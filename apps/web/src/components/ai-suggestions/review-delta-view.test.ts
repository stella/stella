import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { ReviewAlignedPair } from "@/components/ai-suggestions/review-aligned-pair";
import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import {
  PassagesDisclosure,
  ReviewDeltaView,
} from "@/components/ai-suggestions/review-delta-view";
import type { ReviewDeltaViewProps } from "@/components/ai-suggestions/review-delta-view";
import { ReviewPresenceMatrix } from "@/components/ai-suggestions/review-presence-matrix";
import { ReviewTermTable } from "@/components/ai-suggestions/review-term-row";

// This verifies dispatch by inspecting the element tree the component
// returns rather than mounting it. The React Compiler gives the component a
// cache hook, so it is called inside a probe's render, and the probe renders
// nothing: the children never mount and need no providers.
const renderedBy = (props: ReviewDeltaViewProps) => {
  let element: ReturnType<typeof ReviewDeltaView> | undefined;
  const Probe = () => {
    element = ReviewDeltaView(props);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return element ?? panic("The probe did not render the delta view");
};

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
    const element = renderedBy({
      delta,
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([ReviewTermTable, PassagesDisclosure]);
  });

  // The delta names the exact phrase that differs, which is what the pair
  // marks with its strongest highlight.
  test("a parameter delta reaches the pair", () => {
    const delta: ReviewDelta = {
      kind: "parameter",
      standard: null,
      target: null,
    };
    const element = renderedBy({
      delta,
      standard: side,
      target: side,
    });
    // The pair sits behind the passages disclosure, as its children.
    const disclosure = childElements(element).find(
      (child) => child.type === PassagesDisclosure,
    );
    const pair = readProp(disclosure, "children");
    expect(isValidElement(pair) && pair.type).toBe(ReviewAlignedPair);
    expect(readProp(pair, "delta")).toBe(delta);
  });

  // The matrix answers "which limbs", the pair answers "in what words". The
  // second question used to have no answer at all for these two kinds.
  test("an enumeration delta keeps the passages under the matrix", () => {
    const delta: ReviewDelta = { items: [], kind: "enumeration" };
    const element = renderedBy({
      delta,
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([
      ReviewPresenceMatrix,
      PassagesDisclosure,
    ]);
  });

  test("a presence delta keeps the passages under the matrix", () => {
    const delta: ReviewDelta = {
      inStandard: true,
      inTarget: false,
      kind: "presence",
      term: "Losses",
    };
    const element = renderedBy({
      delta,
      standard: side,
      target: side,
    });
    expect(childTypes(element)).toEqual([
      ReviewPresenceMatrix,
      PassagesDisclosure,
    ]);
  });

  test("a language delta is the aligned pair alone, with no delta to mark", () => {
    const delta: ReviewDelta = { kind: "language" };
    const element = renderedBy({
      delta,
      standard: side,
      target: side,
    });
    expect(element.type).toBe(ReviewAlignedPair);
    expect(readProp(element, "delta")).toBeUndefined();
  });

  test("the reference name overrides the standard column label", () => {
    const element = renderedBy({
      delta: { kind: "language" },
      standard: side,
      standardLabel: "Standard (Master NDA)",
      target: side,
    });
    expect(readProp(element, "standardLabel")).toBe("Standard (Master NDA)");
  });
});
