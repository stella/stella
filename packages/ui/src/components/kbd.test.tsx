import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { formatKeys, Kbd } from "./kbd";

describe("Kbd", () => {
  test("spells a combination per platform", () => {
    expect(formatKeys(["mod", "K"], "apple")).toBe("⌘K");
    expect(formatKeys(["mod", "K"], "other")).toBe("Ctrl+K");
    expect(formatKeys(["mod", "shift", "P"], "apple")).toBe("⌘⇧P");
    expect(formatKeys(["mod", "shift", "P"], "other")).toBe("Ctrl+Shift+P");
    expect(formatKeys(["escape"], "apple")).toBe("Esc");
  });

  test("renders the non-Apple spelling on the server, so hydration agrees", () => {
    const markup = renderToStaticMarkup(<Kbd keys={["mod", "enter"]} />);

    expect(markup).toStartWith("<kbd");
    expect(markup).toContain('data-slot="kbd"');
    expect(markup).toContain("Ctrl+Enter");
  });

  test("shows children as written without keys", () => {
    const markup = renderToStaticMarkup(<Kbd>?</Kbd>);

    expect(markup).toContain(">?</kbd>");
  });
});
