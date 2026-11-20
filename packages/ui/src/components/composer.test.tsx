import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { ComposerStatusRow } from "./composer";

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
