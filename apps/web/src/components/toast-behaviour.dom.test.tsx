import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// The shared toast's behaviour in a real DOM. React DOM decides at import time
// whether it can render portals (the toast viewport is one), so the DOM exists
// before anything that loads it.
GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
type Root = ReturnType<typeof createRoot>;

afterAll(async () => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  }
  await unregisterDomEnvironment();
});

const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    stellaToast.dismiss();
    for (const root of mounted.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(<ToastProvider>{null}</ToastProvider>);
  });
};

// Base UI renders an added toast on its next tick.
const settle = async () => {
  await act(async () => {
    await sleep(20);
  });
};

const titles = () =>
  [...document.querySelectorAll('[data-slot="toast-title"]')].map(
    (node) => node.textContent,
  );

const countdowns = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="toast-countdown"]'),
];

test("the same message raised twice shows one toast", async () => {
  await mount();
  let first = "";
  let second = "";
  await act(async () => {
    first = stellaToast.success("Added to starred");
    second = stellaToast.success("Added to starred");
  });
  await settle();
  expect(second).toBe(first);
  expect(titles()).toEqual(["Added to starred"]);
});

test("different messages, types or actions stay separate toasts", async () => {
  await mount();
  await act(async () => {
    stellaToast.success("Saved");
    stellaToast.success("Deleted");
    stellaToast.info("Saved");
    stellaToast.success("Saved", { action: { label: "Undo" } });
    stellaToast.success("Saved", { action: { label: "Undo" } });
  });
  await settle();
  expect(titles().toSorted()).toEqual(
    ["Deleted", "Saved", "Saved", "Saved", "Saved"].toSorted(),
  );
});

test("a timed toast shows a countdown that lasts its timeout; a toast that stays shows none", async () => {
  await mount();
  await act(async () => {
    stellaToast.success("Copied");
  });
  await settle();
  expect(countdowns().map((bar) => bar.style.animationDuration)).toEqual([
    "4000ms",
  ]);
  await act(async () => {
    stellaToast.dismiss();
  });
  await settle();
  await act(async () => {
    stellaToast.success("Pinned until dismissed", { timeout: 0 });
    stellaToast.loading("Saving");
  });
  await settle();
  expect(countdowns()).toHaveLength(0);
});

test("a refreshed toast restarts its countdown", async () => {
  await mount();
  await act(async () => {
    stellaToast.success("Copied");
  });
  await settle();
  const [before] = countdowns();
  await act(async () => {
    stellaToast.success("Copied");
  });
  await settle();
  const [after] = countdowns();
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(after).not.toBe(before);
});

test("the viewport marks a blurred window so the countdown holds with the timer", async () => {
  await mount();
  await act(async () => {
    stellaToast.success("Copied");
  });
  await settle();
  const viewport = document.querySelector<HTMLElement>(
    '[data-slot="toast-viewport"]',
  );
  const hasFocus = document.hasFocus.bind(document);
  try {
    document.hasFocus = () => false;
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await settle();
    expect(viewport?.dataset["windowBlurred"]).toBe("");
    document.hasFocus = () => true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(viewport?.dataset["windowBlurred"]).toBeUndefined();
  } finally {
    document.hasFocus = hasFocus;
  }
});
