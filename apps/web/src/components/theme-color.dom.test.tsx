import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { THEME_STORAGE_KEY } from "../consts";
import { deviceStorage } from "../lib/account/browser-storage";
import { createRootHead, THEME_COLOR } from "../routes/-root-head";

GlobalRegistrator.register({ url: "http://localhost:3000" });

// Happy DOM has no canvas renderer. Only that browser boundary is faked;
// the provider, computed body styles and metadata synchronizer remain real.
const canvasContextDescriptor =
  Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext") ??
  panic("Canvas context descriptor is missing");
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    fillStyle: "",
    fillRect: () => undefined,
    getImageData() {
      switch (this.fillStyle) {
        case "rgb(255, 255, 255)":
          return { data: new Uint8ClampedArray([255, 255, 255, 255]) };
        case "rgb(22, 22, 22)":
          return { data: new Uint8ClampedArray([22, 22, 22, 255]) };
        default:
          return panic(`Unexpected theme fixture colour: ${this.fillStyle}`);
      }
    },
  }),
});

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { ThemeProvider, useTheme, THEMES } = await import("./theme-provider");

afterAll(async () => {
  cleanup();
  Object.defineProperty(
    HTMLCanvasElement.prototype,
    "getContext",
    canvasContextDescriptor,
  );
  await unregisterDomEnvironment();
});

const ThemeControls = () => {
  const { setTheme } = useTheme();
  return (
    <>
      {THEMES.map((theme) => (
        <button type="button" key={theme} onClick={() => setTheme(theme)}>
          {theme}
        </button>
      ))}
    </>
  );
};

test("browser chrome follows runtime light to dark and back without duplicate metadata", async () => {
  deviceStorage("local").setItem(THEME_STORAGE_KEY, "light");
  const style = document.createElement("style");
  style.textContent = `
    body { background-color: rgb(255, 255, 255); }
    html.dark body { background-color: rgb(22, 22, 22); }
  `;
  document.head.append(style);
  const fallbackMetas = createRootHead(false).meta.flatMap((meta) =>
    "media" in meta ? [meta] : [],
  );
  for (const fallback of fallbackMetas) {
    const meta = document.createElement("meta");
    meta.name = fallback.name;
    meta.media = fallback.media;
    meta.content = fallback.content;
    document.head.append(meta);
  }
  const view = render(
    <ThemeProvider>
      <ThemeControls />
    </ThemeProvider>,
  );
  const themeMetaSelector = `meta[name="${THEME_COLOR}"]`;
  const activeMeta = document.head.querySelector(
    `${themeMetaSelector}:not([media])`,
  );
  expect(activeMeta?.getAttribute("content")).toBe("rgb(255 255 255)");

  for (const [theme, bodyColor, metaColor] of [
    ["dark", "rgb(22, 22, 22)", "rgb(22 22 22)"],
    ["light", "rgb(255, 255, 255)", "rgb(255 255 255)"],
  ] as const) {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: theme }));
    });
    expect(getComputedStyle(document.body).backgroundColor).toBe(bodyColor);
    expect(activeMeta?.getAttribute("content")).toBe(metaColor);
    expect(document.head.querySelector(themeMetaSelector)).toBe(activeMeta);
    expect(document.head.querySelectorAll(themeMetaSelector)).toHaveLength(
      fallbackMetas.length + 1,
    );
  }
});
