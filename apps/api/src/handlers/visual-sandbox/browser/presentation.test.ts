import { expect, test } from "bun:test";

import { applyVisualTheme } from "./presentation";

test("keeps the theme in its own stylesheet when authored markup reuses an id", () => {
  const authored = { id: "stella-theme", textContent: "Authored paragraph" };
  const prepended: { tagName: string; textContent: string; id?: string }[] = [];
  const events: string[] = [];
  const document = {
    createElement: (tagName: string) => ({ tagName, textContent: "", id: "" }),
    head: {
      prepend: (element: { tagName: string; textContent: string }) =>
        prepended.push(element),
    },
    querySelector: (selector: string) =>
      selector === "#stella-theme" ? authored : null,
    getElementById: (id: string) => (id === "stella-theme" ? authored : null),
    defaultView: {
      dispatchEvent: (event: Event) => events.push(event.type),
    },
  };

  applyVisualTheme(document, {
    appearance: "dark",
    variables: { "--foreground": "#fafafa" },
  });
  applyVisualTheme(document, {
    appearance: "light",
    variables: { "--foreground": "#171717" },
  });

  expect(authored.textContent).toBe("Authored paragraph");
  expect(prepended).toEqual([
    {
      tagName: "style",
      id: "stella-theme",
      textContent: ":root{color-scheme:light;--foreground:#171717}",
    },
  ]);
  expect(events).toEqual(["stella-theme-change", "stella-theme-change"]);
});
