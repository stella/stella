import { App } from "@modelcontextprotocol/ext-apps";
import type { AppEventMap } from "@modelcontextprotocol/ext-apps";
import { expect, test } from "bun:test";

import {
  createAppSizeReporter,
  INLINE_APP_HEIGHT_CAP,
  mountAppViewport,
} from "./size";

test("shared bridge reports natural short heights, caps long inline content and fills fullscreen", async () => {
  const heights: number[] = [];
  const applied: number[] = [];
  let contentHeight = 60;
  const reporter = createAppSizeReporter({
    app: {
      sendSizeChanged: async ({ height }) => {
        if (height !== undefined) {
          heights.push(height);
        }
      },
    },
    measure: () => ({
      contentHeight,
      toolbarHeight: 52,
      viewportHeight: 900,
      width: 800,
    }),
    apply: (height) => {
      applied.push(height);
    },
    onFailure: () => {
      throw new TypeError("Unexpected size reporting failure");
    },
  });
  await reporter.report();
  expect(heights.at(-1)).toBe(112);
  for (const height of [601, 1200, 10_000, 100_000]) {
    contentHeight = height;
    await reporter.report();
    expect(heights.at(-1)).toBe(INLINE_APP_HEIGHT_CAP);
  }
  await reporter.setContext({
    containerDimensions: { maxHeight: 420, width: 800 },
  });
  expect(heights.at(-1)).toBe(420);
  await reporter.setContext({
    displayMode: "fullscreen",
    containerDimensions: { height: 850, width: 800 },
  });
  expect(heights.at(-1)).toBe(850);
  await reporter.setContext({ displayMode: "inline" });
  expect(heights.at(-1)).toBe(INLINE_APP_HEIGHT_CAP);
  expect(applied).toEqual(heights);
});

test("fullscreen without host dimensions uses the viewport and size failures are surfaced", async () => {
  let sentHeight: number | undefined;
  let failures = 0;
  const reporter = createAppSizeReporter({
    app: {
      sendSizeChanged: async ({ height }) => {
        sentHeight = height;
        throw new TypeError("Transport closed");
      },
    },
    measure: () => ({
      contentHeight: 4000,
      toolbarHeight: 0,
      viewportHeight: 800,
      width: 900,
    }),
    apply: () => {},
    onFailure: () => {
      failures += 1;
    },
  });
  await reporter.setContext({
    displayMode: "fullscreen",
    containerDimensions: { maxHeight: 420, width: 900 },
  });
  expect(sentHeight).toBe(800);
  expect(failures).toBe(1);
});

class ViewportHost extends App {
  listeners = new Set<unknown>();

  override addEventListener<K extends keyof AppEventMap>(
    _event: K,
    listener: (value: AppEventMap[K]) => void,
  ) {
    this.listeners.add(listener);
  }

  override removeEventListener<K extends keyof AppEventMap>(
    _event: K,
    listener: (value: AppEventMap[K]) => void,
  ) {
    this.listeners.delete(listener);
  }

  override async sendSizeChanged() {}
}

test("a second viewport mount replaces the first, and stopping restores the app root", () => {
  document.body.innerHTML = '<main id="app"><p>Results</p></main>';
  const content = document.querySelector("#app");
  const host = new ViewportHost({ name: "viewport-host", version: "1.0.0" });
  const stopFirst = mountAppViewport({ app: host, onFailure: () => {} });
  const stop = mountAppViewport({ app: host, onFailure: () => {} });
  expect(document.querySelectorAll("[data-app-shell]")).toHaveLength(1);
  expect(document.querySelectorAll("[data-app-toolbar]")).toHaveLength(1);
  expect(content?.parentElement?.dataset["appViewport"]).toBe("");
  expect(host.listeners.size).toBe(1);
  stopFirst();
  expect(document.querySelectorAll("[data-app-shell]")).toHaveLength(1);
  stop();
  expect(document.querySelector("[data-app-shell]")).toBeNull();
  expect(content?.parentElement).toBe(document.body);
  expect(host.listeners.size).toBe(0);
  document.body.replaceChildren();
});
