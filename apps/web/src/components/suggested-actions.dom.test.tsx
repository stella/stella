import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { SuggestedActions } = await import("./suggested-actions");

const realMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});
afterAll(unregisterDomEnvironment);

const LONG_LABEL =
  "Jak funguje strop podpory podle § 3a a co znamená výjimka pro projekty s pravomocným rozhodnutím?";

const preferReducedMotion = () => {
  // The test DOM answers every query with `matches: false`; a query that
  // matches everything stands in for the reduced-motion preference.
  window.matchMedia = (query: string) =>
    realMatchMedia(
      query === "(prefers-reduced-motion: reduce)" ? "all" : query,
    );
};

/**
 * Renders one chip whose label is `labelPx` wide inside a `clipPx` box. The
 * test DOM lays nothing out, so the two widths the reveal measures are set
 * on the elements themselves.
 */
const renderChip = ({
  clipPx,
  labelPx,
}: {
  clipPx: number;
  labelPx: number;
}) => {
  const selected: string[] = [];
  const view = render(
    <TooltipProvider>
      <SuggestedActions
        actions={[{ id: "follow-up-0", label: LONG_LABEL }]}
        label="Suggested follow-ups"
        onSelect={(id) => {
          selected.push(id);
        }}
      />
    </TooltipProvider>,
  );
  const chip = view.getByRole("button", { name: LONG_LABEL });
  const label = chip.querySelector<HTMLElement>("[data-reveal]");
  const clip = label?.parentElement;
  if (!label || !clip) {
    throw new Error("The chip renders its label inside a clipping box");
  }
  Object.defineProperty(label, "scrollWidth", { value: labelPx });
  Object.defineProperty(clip, "clientWidth", { value: clipPx });
  return { chip, label, selected, view };
};

describe("a truncated follow-up chip reveals its whole text", () => {
  test("hovering slides the hidden end into view toward the start", () => {
    const { chip, label } = renderChip({ clipPx: 220, labelPx: 520 });
    expect(label.dataset["reveal"]).toBe("rest");
    expect(label.className).toContain("truncate");

    fireEvent.pointerEnter(chip);

    expect(label.dataset["reveal"]).toBe("revealing");
    expect(label.className).not.toContain("truncate");
    expect(label.style.translate).toBe("-300px 0");
    // A reading pace: 300px at 45px/s.
    expect(label.style.transitionDuration).toBe("6667ms");
  });

  test("keyboard focus reveals it the same way, and blur slides it home", () => {
    const { chip, label } = renderChip({ clipPx: 220, labelPx: 520 });

    fireEvent.focus(chip);
    expect(label.dataset["reveal"]).toBe("revealing");

    fireEvent.blur(chip);
    expect(label.dataset["reveal"]).toBe("returning");
    expect(label.style.translate).toBe("0 0");

    // The ellipsis comes back only once the label is home.
    fireEvent.transitionEnd(label);
    expect(label.dataset["reveal"]).toBe("rest");
    expect(label.className).toContain("truncate");
  });

  test("stays revealed while the pointer leaves a chip that keeps focus", () => {
    const { chip, label } = renderChip({ clipPx: 220, labelPx: 520 });

    fireEvent.pointerEnter(chip);
    fireEvent.focus(chip);
    fireEvent.pointerLeave(chip);

    expect(label.dataset["reveal"]).toBe("revealing");
  });

  test("a label that fits does not move", () => {
    const { chip, label } = renderChip({ clipPx: 520, labelPx: 520 });

    fireEvent.pointerEnter(chip);

    expect(label.dataset["reveal"]).toBe("rest");
    expect(label.style.translate).toBe("");
  });

  test("the reveal never changes what the chip sends", () => {
    const { chip, selected } = renderChip({ clipPx: 220, labelPx: 520 });

    fireEvent.pointerEnter(chip);
    fireEvent.click(chip);

    expect(selected).toEqual(["follow-up-0"]);
  });
});

describe("with reduced motion", () => {
  test("the label stays put and a tooltip shows the whole text", async () => {
    preferReducedMotion();
    const { chip, label, view } = renderChip({ clipPx: 220, labelPx: 520 });

    act(() => {
      fireEvent.pointerEnter(chip);
      fireEvent.focus(chip);
    });

    expect(label.dataset["reveal"]).toBe("rest");
    expect(label.style.translate).toBe("");
    await waitFor(() => {
      expect(view.getAllByText(LONG_LABEL)).toHaveLength(2);
    });
  });
});
