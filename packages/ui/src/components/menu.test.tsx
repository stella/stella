import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Menu, MenuAnchor } from "./menu";

test("virtual menu anchors stay hidden and outside the tab order", () => {
  const markup = renderToStaticMarkup(
    <Menu>
      <MenuAnchor />
    </Menu>,
  );

  expect(markup).toContain('data-slot="menu-anchor"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(" hidden=");
});
