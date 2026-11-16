import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Menu, MenuAnchor, MenuTrigger } from "./menu";

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

test("caption triggers forward their name and disabled state without changing default appearance", () => {
  const markup = renderToStaticMarkup(
    <Menu>
      <MenuTrigger
        appearance="caption"
        aria-label="Choose matter"
        className={() => "max-w-48"}
        disabled
      >
        Matter
      </MenuTrigger>
    </Menu>,
  );
  expect(markup).toContain('aria-label="Choose matter"');
  expect(markup).toContain("disabled");
  expect(markup).toContain("text-2xs");
  expect(markup).toContain("max-w-48");
  const defaultMarkup = renderToStaticMarkup(
    <Menu>
      <MenuTrigger
        className={({ disabled }) => (disabled ? "opacity-50" : "max-w-48")}
      >
        Menu
      </MenuTrigger>
    </Menu>,
  );
  expect(defaultMarkup).not.toContain("text-2xs");
  expect(defaultMarkup).toContain("max-w-48");
});
