import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { PresentationPrefsProvider } from "@/lib/account/presentation-prefs/provider";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const { useRef } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { useReaderProvisionMode } =
  await import("@/hooks/use-reader-provision-mode");
const { useWebReaderTextScale } =
  await import("@/components/legal-reader/use-web-reader-text-scale");

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

afterEach(cleanup);

const Reader = ({ label = "reader" }: { label?: string }) => {
  const scrollRef = useRef<HTMLElement | null>(null);
  const mode = useReaderProvisionMode(scrollRef);
  const scale = useWebReaderTextScale();
  return (
    <>
      <article {...scale.rootProps} />
      <button
        aria-label={label}
        aria-pressed={mode.expandProvisions}
        onClick={mode.toggle}
        type="button"
      >
        {mode.expandProvisions ? "expanded" : "collapsed"}
      </button>
    </>
  );
};

test("provision mode is present in the host's first server and client render", () => {
  const initialPrefs = {
    ...defaultPresentationPrefs,
    readerTextScale: 1.4 as const,
    readerProvisionMode: "expanded" as const,
  };
  const tree = (
    <PresentationPrefsProvider initialPrefs={initialPrefs}>
      <Reader />
    </PresentationPrefsProvider>
  );
  expect(renderToString(tree)).toContain(
    '<article data-slot="reader-text-root" style="--reader-text-scale:1.4"></article>',
  );
  expect(renderToString(tree)).toContain('aria-pressed="true"');
  const rendered = render(tree);
  expect(
    rendered.container
      .querySelector('[data-slot="reader-text-root"]')
      ?.getAttribute("style"),
  ).toBe("--reader-text-scale: 1.4;");
  expect(
    rendered.container.querySelector("button")?.getAttribute("aria-pressed"),
  ).toBe("true");
});

test("mounted readers share the server preference and each toggle", () => {
  const saved: Partial<PresentationPrefs>[] = [];
  const tree = (
    <PresentationPrefsProvider
      initialPrefs={defaultPresentationPrefs}
      persist={(patch) => {
        saved.push(patch);
      }}
    >
      <Reader label="page" />
      <Reader label="inspector" />
    </PresentationPrefsProvider>
  );
  const rendered = render(tree);
  const page = rendered.getByRole("button", { name: "page" });
  const inspector = rendered.getByRole("button", { name: "inspector" });
  expect(page.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(page);
  expect(page.getAttribute("aria-pressed")).toBe("true");
  expect(inspector.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(inspector);
  expect(page.getAttribute("aria-pressed")).toBe("false");
  expect(inspector.getAttribute("aria-pressed")).toBe("false");
  expect(saved).toEqual([
    { readerProvisionMode: "expanded" },
    { readerProvisionMode: "collapsed" },
  ]);
});

afterAll(async () => {
  await unregisterDomEnvironment();
});
