import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { NumberInput } from "./number-input";

describe("NumberInput", () => {
  test("keeps structured editing LTR and coarse-pointer targets by default", () => {
    const markup = renderToStaticMarkup(<NumberInput />);

    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("pointer-coarse:min-h-11");
    // The element fills the control it is given, so the coarse-pointer target
    // above is the whole typing surface and not a band at the top of it.
    expect(markup).toContain("h-full");
  });

  test("allows an explicit direction override", () => {
    const markup = renderToStaticMarkup(<NumberInput dir="rtl" />);

    expect(markup).toContain('dir="rtl"');
  });

  test("reads as a spin button with its bounds and current value", () => {
    const markup = renderToStaticMarkup(
      <NumberInput
        inputProps={{ "aria-label": "Quantity" }}
        max={10}
        min={1}
        value={4}
      />,
    );

    expect(markup).toContain('role="spinbutton"');
    expect(markup).toContain('aria-valuemin="1"');
    expect(markup).toContain('aria-valuemax="10"');
    expect(markup).toContain('aria-valuenow="4"');
  });
});

describe("NumberInput suffix", () => {
  test("shows its unit after the number in tabular digits", () => {
    const markup = renderToStaticMarkup(
      <NumberInput
        inputProps={{ "aria-label": "Margin" }}
        suffix="pt"
        value={12}
      />,
    );

    expect(markup).toContain('data-slot="number-input-suffix"');
    expect(markup).toContain(">pt</span>");
    expect(markup).toContain("tabular-nums");
  });

  test("adds no suffix slot without a unit", () => {
    const markup = renderToStaticMarkup(
      <NumberInput inputProps={{ "aria-label": "Margin" }} value={12} />,
    );

    expect(markup).not.toContain("number-input-suffix");
  });
});
