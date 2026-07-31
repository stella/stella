import { expect, test } from "@playwright/test";

// Class guard: the landing anonymization demo must detect entities in a real
// browser bundle, not just under Node. Its dictionaries reach the worker
// through dynamic imports; a specifier the bundler cannot see statically
// resolves at runtime against the emitted chunk instead of the package,
// 404s, and the loader's internal try/catch turns that miss into an empty
// list. Detection then silently drops every city (and with it every street
// address, which the engine only emits when a known city anchors it) while
// every Node-level unit test keeps passing, because there the same specifier
// resolves straight off disk. Nothing short of driving the shipped bundle in
// a browser can see the difference, so this spec types a city into the live
// demo and asserts the engine highlights it as an address.

const DEMO_SELECTORS = {
  textarea: "#anon-demo-textarea",
  entitySpan: ".entity-span",
  status: "[aria-live]",
  legendItem: "li",
} as const;

const DEMO_URL = "/product/anonymization";

// A city only a loaded city dictionary can resolve (CZ list), in a sentence
// that carries no other entity, so the expected result is exactly one
// address and nothing else.
const CITY = "Prague";
const PROBE_TEXT = `The meeting took place in ${CITY}.`;
// AnonymizeLiveDemo's display bucket for the pipeline's "address" label.
const ADDRESS_LEGEND = "Address";

// Every entity of AnonymizeLiveDemo's default sample, in the order it appears
// in the paragraph (the person is named twice, so it is highlighted twice).
// Written out here rather than imported from the island so the spec is an
// independent statement of what a visitor must see.
const SAMPLE_HIGHLIGHTS = [
  "Laure Chevalier",
  "14 Rue de la Paix, Paris",
  "Meridian Capital Partners LLC",
  "Edison Bank plc",
  "Laure Chevalier",
  "+33 1 42 61 53 00",
  "laure.chevalier@meridiancapital.example",
  "FR12 345678901",
];

type DemoState = {
  // The demo's aria-live status line, carried for failure diagnostics: a
  // missing cross-origin-isolation header or a wasm boot failure surfaces
  // here instead of leaving an unexplained empty highlight list.
  status: string;
  highlighted: string[];
  legend: string[];
};

// Runs in the page. The demo has no root test id, so anchor on the textarea's
// id and walk up to the component root (textarea → text-layer wrapper → root)
// to keep the reads scoped to the island.
const readDemoState = (selectors: typeof DEMO_SELECTORS): DemoState => {
  const root =
    document.querySelector(selectors.textarea)?.parentElement?.parentElement ??
    null;
  if (!root) {
    return { status: "demo island not mounted", highlighted: [], legend: [] };
  }
  const readText = (node: Element | null) => node?.textContent.trim() ?? "";
  return {
    status: readText(root.querySelector(selectors.status)),
    highlighted: [...root.querySelectorAll(selectors.entitySpan)].map(readText),
    legend: [...root.querySelectorAll(selectors.legendItem)].map(readText),
  };
};

test("live anonymization demo highlights a city as an address", async ({
  page,
}) => {
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  const textarea = page.locator(DEMO_SELECTORS.textarea);
  await expect(textarea).toBeVisible();

  // The island hydrates on `client:visible`, and the server-rendered textarea
  // accepts input before that: typing early would be thrown away the moment
  // React mounts with its own default text. Waiting for the status line to
  // leave its warming copy proves the island is hydrated and the wasm runtime
  // has answered once, so the fill below lands on the controlled textarea.
  // Generous: that first answer boots the runtime and fetches the name and
  // per-country city dictionary chunks.
  await expect
    .poll(
      async () => (await page.evaluate(readDemoState, DEMO_SELECTORS)).status,
      { message: "the demo's engine finishes booting", timeout: 90_000 },
    )
    .toMatch(/detected/u);

  // Handing over from the precomputed sample highlights to live engine output
  // must not change what is on screen: same spans, same order.
  await expect
    .poll(
      async () =>
        (await page.evaluate(readDemoState, DEMO_SELECTORS)).highlighted,
      { message: "engine output matches the precomputed sample highlights" },
    )
    .toEqual(SAMPLE_HIGHLIGHTS);

  await textarea.fill(PROBE_TEXT);

  await expect
    .poll(async () => page.evaluate(readDemoState, DEMO_SELECTORS), {
      message: `the engine highlights "${CITY}" as an address`,
      timeout: 30_000,
    })
    .toMatchObject({ highlighted: [CITY], legend: [ADDRESS_LEGEND] });
});

test("live anonymization demo does not expose runtime errors", async ({
  page,
}) => {
  await page.route(/\.wasm(?:\?|$)/u, async (route) => {
    await route.abort("failed");
  });
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  await expect(page.locator(DEMO_SELECTORS.textarea)).toBeVisible();
  await expect(page.locator(DEMO_SELECTORS.status)).toHaveText(
    "Something went wrong.",
    { timeout: 30_000 },
  );
});

// The engine is hundreds of kilobytes of wasm plus name and city
// dictionaries, so the demo would otherwise open on a loading line and show a
// visitor nothing until all of it lands. The island renders the untouched
// sample from precomputed pairs instead, which makes the highlights part of
// the server-rendered markup. Disabling JavaScript outright is the
// deterministic way to assert that: no worker, no hydration, no engine, and
// therefore no chance of the live result racing in and passing this for the
// wrong reason.
test.describe("before the engine loads", () => {
  test.use({ javaScriptEnabled: false });

  test("the sample's highlights render without any script", async ({
    page,
  }) => {
    await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

    const root = page.locator(DEMO_SELECTORS.textarea).locator("xpath=../..");
    await expect(root.locator(DEMO_SELECTORS.textarea)).toBeVisible();

    await expect(root.locator(DEMO_SELECTORS.entitySpan)).toHaveText(
      SAMPLE_HIGHLIGHTS,
    );
    await expect(root.locator(DEMO_SELECTORS.legendItem)).toHaveText([
      "Person",
      "Address",
      "Organization",
      "Phone",
      "Email",
      "ID / number",
    ]);
    // Honest about where the highlights came from, and phrased so the poll in
    // the test above cannot mistake it for a finished run.
    await expect(root.locator(DEMO_SELECTORS.status)).toHaveText(/warming up/u);
  });
});
