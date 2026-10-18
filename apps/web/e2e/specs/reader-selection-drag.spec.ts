import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "reader-selection-drag-"));
const fixture = { bundle: "" };
test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 900, height: 760 },
});
test.beforeAll(() => {
  const output = path.join(directory, "fixture.js");
  execFileSync(
    "bun",
    [
      "build",
      path.resolve(
        import.meta.dirname,
        "../fixtures/reader-selection-drag.fixture.tsx",
      ),
      "--target=browser",
      "--minify",
      '--define=process.env.NODE_ENV="production"',
      // The reader pulls the app's router module in; the fixture never
      // navigates, so its generated server entries stay unresolved.
      "--external=#tanstack-router-entry",
      "--external=#tanstack-start-entry",
      "--outfile",
      output,
    ],
    { stdio: "pipe" },
  );
  fixture.bundle = readFileSync(output, "utf-8");
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

// The app stylesheet needs the dev server; the bar's placement only needs
// the utilities it is built from, so the fixture page carries those alone.
const toolbarUtilities = `
  .fixed { position: fixed; }
  .z-\\[100\\] { z-index: 100; }
  .-translate-x-1\\/2 { transform: translateX(-50%); }
  .bg-popover { background: #fff; }
  .border { border: 1px solid #ccc; }
`;

const mountReader = async (page: Page) => {
  await page.setContent(
    `<head><style>${toolbarUtilities}</style></head><body style="margin:0"><div id="fixture"></div></body>`,
  );
  await page.addScriptTag({ content: fixture.bundle });
  await expect(page.getByTestId("reader")).toBeVisible();
};

type FrameSample = {
  focusInsideReader: boolean;
  anchorInsideReader: boolean;
  length: number;
};

/** Records the selection on every animation frame until stopped. */
const recordSelectionFrames = async (page: Page) => {
  await page.evaluate(() => {
    const reader = window.document.querySelector('[data-testid="reader"]');
    const samples: FrameSample[] = [];
    let running = true;
    const tick = () => {
      const selection = window.document.getSelection();
      if (selection !== null && selection.rangeCount > 0) {
        samples.push({
          anchorInsideReader: reader?.contains(selection.anchorNode) ?? false,
          focusInsideReader: reader?.contains(selection.focusNode) ?? false,
          length: selection.toString().length,
        });
      }
      if (running) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    Object.assign(window, {
      stopSelectionFrames: () => {
        running = false;
        return samples;
      },
    });
  });
};

const stopSelectionFrames = async (page: Page): Promise<FrameSample[]> =>
  await page.evaluate(() => {
    const stop: unknown = Reflect.get(window, "stopSelectionFrames");
    if (typeof stop !== "function") {
      throw new TypeError("Selection recorder was not installed");
    }
    const samples: unknown = stop();
    if (!Array.isArray(samples)) {
      throw new TypeError("Selection recorder returned no samples");
    }
    return samples.flatMap((sample: unknown): FrameSample[] =>
      typeof sample === "object" &&
      sample !== null &&
      "anchorInsideReader" in sample &&
      "focusInsideReader" in sample &&
      "length" in sample &&
      typeof sample.anchorInsideReader === "boolean" &&
      typeof sample.focusInsideReader === "boolean" &&
      typeof sample.length === "number"
        ? [
            {
              anchorInsideReader: sample.anchorInsideReader,
              focusInsideReader: sample.focusInsideReader,
              length: sample.length,
            },
          ]
        : [],
    );
  });

const lineBox = async (page: Page, line: number) => {
  const box = await page.locator(`p[data-line="${line}"]`).boundingBox();
  if (box === null) {
    throw new Error(`Paragraph ${line} has no box`);
  }
  return box;
};

test("a fast drag across paragraphs never selects past the reader", async ({
  page,
}) => {
  await mountReader(page);
  const first = await lineBox(page, 1);
  const last = await lineBox(page, 8);
  const readerText =
    (await page.getByTestId("reader").textContent())?.length ?? 0;
  await recordSelectionFrames(page);
  await page.mouse.move(first.x + 4, first.y + 6);
  await page.mouse.down();
  // Sweep up and down over the paragraphs and the gaps between them, the
  // way a reader overshoots and corrects, a few frames per sweep.
  for (let sweep = 0; sweep < 6; sweep += 1) {
    const down = sweep % 2 === 0;
    for (let step = 1; step <= 12; step += 1) {
      const fraction = down ? step / 12 : 1 - step / 12;
      await page.mouse.move(
        first.x + 40 + fraction * 300,
        first.y + 30 + fraction * (last.y + last.height - first.y - 30),
      );
    }
  }
  await page.mouse.up();
  const samples = await stopSelectionFrames(page);
  expect(samples.length).toBeGreaterThan(10);
  const escaped = samples.filter(
    (sample) =>
      !sample.anchorInsideReader ||
      !sample.focusInsideReader ||
      sample.length > readerText,
  );
  expect(escaped).toEqual([]);
});

test("the selection bar keeps its place once the drag ends", async ({
  page,
}) => {
  await mountReader(page);
  const first = await lineBox(page, 2);
  const last = await lineBox(page, 4);
  await page.mouse.move(first.x + 4, first.y + 6);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      first.x + 4 + (step / 10) * 260,
      first.y + 6 + (step / 10) * (last.y + 10 - first.y - 6),
    );
  }
  // The reader's bar is the one fixed element the fixture renders.
  const toolbar = page.locator("div.fixed.reader-chrome");
  const beforeRelease = await toolbar.boundingBox();
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
  const shown = await toolbar.boundingBox();
  await page.waitForTimeout(300);
  const settled = await toolbar.boundingBox();
  expect(shown).not.toBeNull();
  expect(settled).toEqual(shown);
  if (beforeRelease !== null) {
    expect(shown).toEqual(beforeRelease);
  }
});
