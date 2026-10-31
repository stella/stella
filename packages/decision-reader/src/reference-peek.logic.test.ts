import { createElement } from "react";

import { describe, expect, test } from "bun:test";

import {
  PEEK_ACTION,
  PEEK_TRIGGER_CLICK,
  peekActionItems,
  peekTriggerClick,
  REFERENCE_PEEK_KINDS,
} from "./reference-peek.logic";
import type { ReferencePeekTarget } from "./reference-peek.logic";

const pageLink = createElement("a", { href: "/law/cze/cases/court/case" });
const openBeside = () => undefined;

/** Every kind with a target for each action it offers. */
const everyTarget = {
  decision: {
    kind: "decision",
    actions: {
      openInSidePanel: openBeside,
      openInStella: pageLink,
      openOriginal: "https://publisher.example.test/decision",
    },
  },
  provision: {
    kind: "provision",
    actions: {
      openInSidePanel: openBeside,
      openInStella: pageLink,
      openOriginal: "https://publisher.example.test/provision",
    },
  },
  statute: {
    kind: "statute",
    actions: { openInSidePanel: openBeside, openInStella: pageLink },
  },
  unresolvedCitation: { kind: "unresolvedCitation", actions: {} },
} as const satisfies {
  [Kind in ReferencePeekTarget["kind"]]: Extract<
    ReferencePeekTarget,
    { kind: Kind }
  >;
};

describe("reference peek kinds", () => {
  test("every kind offers each action at most once", () => {
    for (const spec of Object.values(REFERENCE_PEEK_KINDS)) {
      expect(new Set(spec.actions).size).toBe(spec.actions.length);
      for (const action of spec.actions) {
        expect(Object.values(PEEK_ACTION)).toContain(action);
      }
    }
  });

  test("every kind lists its actions in the one shared order", () => {
    const order = Object.values(PEEK_ACTION);
    for (const spec of Object.values(REFERENCE_PEEK_KINDS)) {
      const positions = spec.actions.map((action) => order.indexOf(action));
      expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    }
  });

  test("a kind stella can open offers both the side panel and its page", () => {
    for (const [kind, spec] of Object.entries(REFERENCE_PEEK_KINDS)) {
      const actions: readonly string[] = spec.actions;
      if (kind === "unresolvedCitation") {
        // Nothing in stella to open: the peek only says so.
        expect(actions).toEqual([]);
        continue;
      }
      expect(actions.slice(0, 2)).toEqual([
        PEEK_ACTION.openInSidePanel,
        PEEK_ACTION.openInStella,
      ]);
    }
  });

  test("a kind shows exactly the actions its map entry lists when all have targets", () => {
    expect(Object.keys(everyTarget).toSorted()).toEqual(
      Object.keys(REFERENCE_PEEK_KINDS).toSorted(),
    );
    for (const target of Object.values(everyTarget)) {
      expect(
        peekActionItems({ target, sidePanelAvailable: true }).map(
          ({ type }) => type,
        ),
      ).toEqual([...REFERENCE_PEEK_KINDS[target.kind].actions]);
    }
  });

  test("an action without a target is left out, and a phone has no side panel", () => {
    const decision = {
      kind: "decision",
      actions: {
        openInSidePanel: null,
        openInStella: pageLink,
        openOriginal: null,
      },
    } as const satisfies ReferencePeekTarget;
    expect(
      peekActionItems({ target: decision, sidePanelAvailable: true }).map(
        ({ type }) => type,
      ),
    ).toEqual([PEEK_ACTION.openInStella]);
    expect(
      peekActionItems({
        target: everyTarget.provision,
        sidePanelAvailable: false,
      }).map(({ type }) => type),
    ).toEqual([PEEK_ACTION.openInStella, PEEK_ACTION.openOriginal]);
  });
});

describe("a click on a reference that peeks", () => {
  const plain = {
    altKey: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };

  test("a plain primary click opens the peek", () => {
    expect(peekTriggerClick(plain)).toBe(PEEK_TRIGGER_CLICK.open);
  });

  test("every browser navigation gesture keeps its meaning", () => {
    for (const gesture of [
      { ...plain, button: 1 },
      { ...plain, ctrlKey: true },
      { ...plain, metaKey: true },
      { ...plain, shiftKey: true },
      { ...plain, altKey: true },
    ]) {
      expect(peekTriggerClick(gesture)).toBe(PEEK_TRIGGER_CLICK.navigate);
    }
  });
});
