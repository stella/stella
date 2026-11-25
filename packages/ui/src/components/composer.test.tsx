import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ComposerStatusRow } from "./composer";
import { ComposerFrame } from "./composer-frame";

describe("ComposerStatusRow", () => {
  // A chip in the row compacts by the row's width (`@max-xl/composer-status:`),
  // so both layouts must declare that container.
  test.each([
    ["with a middle slot", { center: <span>centre</span> }],
    ["without a middle slot", {}],
  ] as const)("is the composer-status container %s", (_layout, slots) => {
    const markup = renderToStaticMarkup(
      <ComposerStatusRow
        end={<span>end</span>}
        start={<span>start</span>}
        {...slots}
      />,
    );

    expect(markup).toContain("@container/composer-status");
  });
});

describe("ComposerFrame", () => {
  // The first paint is the layout the draft needs before anything is
  // measured: a compact composer is the bar, a large one already stacks its
  // text over the control row.
  test.each([
    ["compact", "bar"],
    ["large", "stacked"],
  ] as const)("a %s frame first paints as %s", (stature, layout) => {
    const markup = renderToStaticMarkup(
      stature === "compact" ? (
        <ComposerFrame
          empty
          ring="focus"
          stature="compact"
          text={<textarea dir="ltr" />}
        />
      ) : (
        <ComposerFrame
          ring="focus"
          stature="large"
          text={<textarea dir="ltr" />}
        />
      ),
    );

    expect(markup).toContain(`data-composer-layout="${layout}"`);
    expect(markup).toContain('data-slot="composer-text-region"');
  });

  test("a surface may name the box for its own tests", () => {
    const markup = renderToStaticMarkup(
      <ComposerFrame
        data-slot="gated-chat-sign-in"
        empty
        ring="none"
        stature="compact"
        text={null}
      />,
    );

    expect(markup).toContain('data-slot="gated-chat-sign-in"');
    expect(markup).not.toContain('data-slot="composer-frame"');
  });
});
