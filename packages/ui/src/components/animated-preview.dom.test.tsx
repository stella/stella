import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "../testing/dom-environment";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const {
  ANIMATED_PREVIEW_CARD_DELAY_MS,
  AnimatedPreview,
  AnimatedPreviewCard,
  AnimatedPreviewMotion,
} = await import("./animated-preview");

const realMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const preferReducedMotion = () => {
  // The test DOM answers every query with `matches: false`; a query that
  // matches everything stands in for the reduced-motion preference.
  window.matchMedia = (query: string) =>
    realMatchMedia(
      query === "(prefers-reduced-motion: reduce)" ? "all" : query,
    );
};

const STAGES = [
  { id: "write", content: "You write" },
  { id: "send", content: "It is sent" },
  { id: "read", content: "You read" },
] as const;

const stagesOf = (frame: Element): HTMLElement[] =>
  [...frame.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset["slot"] === "animated-preview-stage",
  );

const frameIn = (container: HTMLElement): HTMLElement => {
  const frame = container.querySelector<HTMLElement>(
    '[data-slot="animated-preview"]',
  );
  if (!frame) {
    throw new Error("no animated-preview frame rendered");
  }
  return frame;
};

const roles = (stage: HTMLElement) => ({
  index: stage.dataset["stageIndex"],
  incoming: stage.dataset["incoming"] !== undefined,
  outgoing: stage.dataset["outgoing"] !== undefined,
  text: stage.textContent,
});

describe("AnimatedPreview", () => {
  test("renders every stage in order, the first there from the start and the last staying", () => {
    const view = render(<AnimatedPreview stages={STAGES} />);
    const frame = frameIn(view.container);

    expect(frame.dataset["playback"]).toBe("once");
    expect(frame.dataset["motion"]).toBe("full");
    expect(stagesOf(frame).map(roles)).toEqual([
      { index: "0", incoming: false, outgoing: true, text: "You write" },
      { index: "1", incoming: true, outgoing: true, text: "It is sent" },
      { index: "2", incoming: true, outgoing: false, text: "You read" },
    ]);
  });

  test("a looping frame brings every stage in and out, and starts over once the last stage has gone out", () => {
    const view = render(<AnimatedPreview playback="loop" stages={STAGES} />);
    const frame = frameIn(view.container);

    expect(frame.dataset["playback"]).toBe("loop");
    expect(
      stagesOf(frame).map(({ dataset }) => [
        dataset["incoming"] !== undefined,
        dataset["outgoing"] !== undefined,
      ]),
    ).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);

    const [first, middle, last] = stagesOf(frame);
    if (!first || !middle || !last) {
      throw new Error("expected three stages");
    }
    // A stage that is not the last one going out keeps the cycle running.
    fireEvent.animationEnd(middle, {
      animationName: "animated-preview-fade-out",
    });
    expect(stagesOf(frame)[0]).toBe(first);

    // The last stage only coming in does not restart anything either.
    fireEvent.animationEnd(last, { animationName: "animated-preview-fade-in" });
    expect(stagesOf(frame)[0]).toBe(first);

    fireEvent.animationEnd(last, {
      animationName: "animated-preview-fade-out",
    });
    const restarted = stagesOf(frame);
    expect(restarted.map(({ textContent }) => textContent)).toEqual([
      "You write",
      "It is sent",
      "You read",
    ]);
    expect(restarted[0]).not.toBe(first);
  });

  test("a frame playing once does not start over", () => {
    const view = render(<AnimatedPreview stages={STAGES} />);
    const frame = frameIn(view.container);
    const [first, , last] = stagesOf(frame);
    if (!first || !last) {
      throw new Error("expected three stages");
    }

    fireEvent.animationEnd(last, {
      animationName: "animated-preview-fade-out",
    });

    expect(stagesOf(frame)[0]).toBe(first);
  });

  test("a nested frame's stages do not restart the frame around it", () => {
    const view = render(
      <AnimatedPreview
        playback="loop"
        stages={[
          {
            id: "outer",
            content: (
              <AnimatedPreview
                inline
                pace="beat"
                stages={[
                  { id: "name", content: "Jana" },
                  { id: "placeholder", content: "[PERSON_1]" },
                ]}
              />
            ),
          },
        ]}
      />,
    );
    const frames = view.container.querySelectorAll<HTMLElement>(
      '[data-slot="animated-preview"]',
    );
    const [outer, inner] = frames;
    if (!outer || !inner) {
      throw new Error("expected a nested frame");
    }
    expect(inner.tagName).toBe("SPAN");
    const [outerStage] = stagesOf(outer);
    const [innerFirst] = stagesOf(inner);
    if (!outerStage || !innerFirst) {
      throw new Error("expected stages");
    }

    fireEvent.animationEnd(innerFirst, {
      animationName: "animated-preview-fade-out",
    });

    expect(stagesOf(outer)[0]).toBe(outerStage);
  });

  test("with reduced motion only the final stage renders, with nothing to animate", () => {
    preferReducedMotion();
    const view = render(<AnimatedPreview playback="loop" stages={STAGES} />);
    const frame = frameIn(view.container);

    expect(frame.dataset["motion"]).toBe("reduced");
    expect(stagesOf(frame).map(roles)).toEqual([
      { index: "2", incoming: false, outgoing: false, text: "You read" },
    ]);
  });

  test("a carry rests at its target with reduced motion", () => {
    const moving = render(<AnimatedPreviewMotion>card</AnimatedPreviewMotion>);
    expect(
      moving.container.querySelector<HTMLElement>(
        '[data-slot="animated-preview-motion"]',
      )?.dataset["motion"],
    ).toBe("full");
    cleanup();

    preferReducedMotion();
    const resting = render(<AnimatedPreviewMotion>card</AnimatedPreviewMotion>);
    expect(
      resting.container.querySelector<HTMLElement>(
        '[data-slot="animated-preview-motion"]',
      )?.dataset["motion"],
    ).toBe("reduced");
  });
});

describe("AnimatedPreviewCard", () => {
  const renderCard = () =>
    render(
      <AnimatedPreviewCard
        description="Replaces personal data before sending."
        trigger={<button type="button">Shield</button>}
      >
        <AnimatedPreview stages={STAGES} />
      </AnimatedPreviewCard>,
    );

  const openCard = () =>
    document.querySelector('[data-slot="animated-preview-card"]');

  test("the description describes the trigger while the card is closed", () => {
    const view = renderCard();
    const trigger = view.getByRole("button", { name: "Shield" });
    const descriptionId = trigger.getAttribute("aria-describedby");

    expect(descriptionId).toBeTruthy();
    expect(
      document.querySelector(`[id="${descriptionId ?? ""}"]`)?.textContent,
    ).toBe("Replaces personal data before sending.");
    expect(openCard()).toBeNull();
  });

  test("hovering the trigger opens the card only after the delay", async () => {
    const view = renderCard();
    const trigger = view.getByRole("button", { name: "Shield" });
    const startedAt = performance.now();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseMove(trigger);
    expect(openCard()).toBeNull();

    await waitFor(
      () => {
        expect(openCard()).not.toBeNull();
      },
      { timeout: ANIMATED_PREVIEW_CARD_DELAY_MS * 4 },
    );
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
      ANIMATED_PREVIEW_CARD_DELAY_MS - 20,
    );
    const card = openCard();
    expect(
      card?.querySelector('[data-slot="animated-preview"]'),
    ).not.toBeNull();
    expect(
      card?.querySelector('[data-slot="animated-preview-card-description"]')
        ?.textContent,
    ).toBe("Replaces personal data before sending.");
    // Opening the card leaves focus where it was.
    expect(document.activeElement).not.toBe(card);
  });

  test("keyboard focus on the trigger opens the card", async () => {
    const view = renderCard();
    const trigger = view.getByRole("button", { name: "Shield" });

    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => {
      trigger.focus();
    });

    await waitFor(
      () => {
        expect(openCard()).not.toBeNull();
      },
      { timeout: ANIMATED_PREVIEW_CARD_DELAY_MS * 4 },
    );
    expect(document.activeElement).toBe(trigger);
  });
});
