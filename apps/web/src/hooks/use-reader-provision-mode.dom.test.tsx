import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { defaultPresentationPrefs } from "@/lib/presentation-prefs";
import { PresentationPrefsProvider } from "@/lib/presentation-prefs-provider";

const { render } = await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { useReaderProvisionMode } =
  await import("@/hooks/use-reader-provision-mode");
const { useWebReaderTextScale } =
  await import("@/components/legal-reader/use-web-reader-text-scale");

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const Reader = () => {
  const mode = useReaderProvisionMode();
  const scale = useWebReaderTextScale();
  return (
    <>
      <article {...scale.rootProps} />
      <button aria-pressed={mode.expandProvisions} type="button">
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

afterAll(async () => {
  await GlobalRegistrator.unregister();
});
