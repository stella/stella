import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { formatKeys, Kbd, kbdPlatformOf } from "./kbd";
import { MenuShortcut } from "./menu";

describe("Kbd", () => {
  test("spells a combination per platform", () => {
    expect(formatKeys(["mod", "K"], "apple")).toBe("⌘K");
    expect(formatKeys(["mod", "K"], "other")).toBe("Ctrl+K");
    expect(formatKeys(["mod", "shift", "P"], "apple")).toBe("⌘⇧P");
    expect(formatKeys(["mod", "shift", "P"], "other")).toBe("Ctrl+Shift+P");
    expect(formatKeys(["escape"], "apple")).toBe("Esc");
  });

  test("reads the platform from userAgentData, else navigator.platform", () => {
    expect(
      kbdPlatformOf({
        platform: "Win32",
        userAgentData: { platform: "macOS" },
      }),
    ).toBe("apple");
    expect(kbdPlatformOf({ platform: "MacIntel" })).toBe("apple");
    // An empty userAgentData platform is no answer.
    expect(
      kbdPlatformOf({ platform: "MacIntel", userAgentData: { platform: "" } }),
    ).toBe("apple");
    expect(
      kbdPlatformOf({
        platform: "Linux x86_64",
        userAgentData: { platform: "" },
      }),
    ).toBe("other");
  });

  test("renders the non-Apple spelling on the server, so hydration agrees", () => {
    const markup = renderToStaticMarkup(<Kbd keys={["mod", "enter"]} />);

    expect(markup).toStartWith("<kbd");
    expect(markup).toContain('data-slot="kbd"');
    expect(markup).toContain("Ctrl+Enter");
  });

  test("a menu shortcut is the plain variant, not a restyled cap", () => {
    const markup = renderToStaticMarkup(<MenuShortcut keys={["mod", "K"]} />);

    expect(markup).toContain('data-variant="plain"');
    expect(markup).toContain('data-slot="menu-shortcut"');
    expect(markup).toContain("ms-auto");
    expect(markup).not.toContain("bg-muted");
    for (const override of ["border-0", "bg-transparent", "h-auto", "px-0"]) {
      expect(markup).not.toContain(override);
    }
  });

  test("shows children as written without keys", () => {
    const markup = renderToStaticMarkup(<Kbd>?</Kbd>);

    expect(markup).toContain(">?</kbd>");
  });
});
