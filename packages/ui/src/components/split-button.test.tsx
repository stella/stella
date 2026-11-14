import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { FileTextIcon } from "../icons";
import { BUTTON_CONTENT } from "./button";
import { SplitButton } from "./split-button";

const CONTENTS = Object.values(BUTTON_CONTENT);

// The primary action is the first button the split renders; Base UI marks the
// element a mounted tooltip is attached to.
const primaryHasTooltip = (markup: string) => {
  const primary = /<button[^>]*>/u.exec(markup)?.at(0);
  expect(primary).toBeDefined();
  return primary?.includes("data-base-ui-tooltip-trigger") ?? false;
};

test.each(CONTENTS)(
  "%s primary content: its label is a tooltip only for a glyph",
  (content) => {
    const markup = renderToStaticMarkup(
      <SplitButton
        menu={null}
        menuLabel="More create options"
        onPrimaryClick={() => undefined}
        primaryContent={content}
        primaryLabel="Create document"
      >
        <FileTextIcon aria-hidden="true" />
        {content === BUTTON_CONTENT.text ? "Create" : null}
      </SplitButton>,
    );
    expect(primaryHasTooltip(markup)).toBe(content === BUTTON_CONTENT.icon);
  },
);

test("a text primary gets no tooltip", () => {
  const markup = renderToStaticMarkup(
    <SplitButton
      menu={null}
      menuLabel="More create options"
      onPrimaryClick={() => undefined}
    >
      Create document
    </SplitButton>,
  );
  expect(primaryHasTooltip(markup)).toBe(false);
});
