import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "selection-toolbar-"));
const fixture = { bundle: "" };
test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 900, height: 700 },
});
test.beforeAll(() => {
  const output = path.join(directory, "fixture.js");
  execFileSync(
    "bun",
    [
      "build",
      path.resolve(
        import.meta.dirname,
        "../fixtures/selection-toolbar.fixture.tsx",
      ),
      "--target=browser",
      "--minify",
      '--define=process.env.NODE_ENV="production"',
      "--outfile",
      output,
    ],
    { stdio: "pipe" },
  );
  fixture.bundle = readFileSync(output, "utf-8");
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

const cases = {
  pointer: { pointer: true, first: 0, last: 11, endOffset: null },
  clippedEnd: { pointer: false, first: 0, last: 11, endOffset: null },
  visibleEnd: { pointer: false, first: 0, last: 0, endOffset: 60 },
  offscreen: { pointer: false, first: 11, last: 11, endOffset: null },
};
for (const [name, selectionCase] of Object.entries(cases)) {
  test(`selection toolbar follows ${name} within its pane`, async ({
    page,
    context,
  }) => {
    // Vite injects styles in development; production emits hashed asset links.
    const stylesheetPage = await context.newPage();
    await stylesheetPage.goto("/auth");
    await expect
      .poll(
        async () =>
          await stylesheetPage.evaluate(() => {
            const probe = window.document.createElement("div");
            probe.className = "fixed -translate-x-1/2";
            window.document.body.append(probe);
            const position = window.getComputedStyle(probe).position;
            probe.remove();
            return position;
          }),
      )
      .toBe("fixed");
    const styles = await stylesheetPage.evaluate(() =>
      Array.from(
        window.document.querySelectorAll("style, link[rel='stylesheet']"),
      )
        .map((node) => {
          if (node instanceof HTMLLinkElement) {
            const link = node.cloneNode();
            if (!(link instanceof HTMLLinkElement)) {
              throw new Error("Stylesheet link clone changed element type");
            }
            link.href = node.href;
            return link.outerHTML;
          }
          return node.outerHTML;
        })
        .join("\n"),
    );
    await stylesheetPage.close();
    await page.setContent(`<head>${styles}</head><div id="fixture"></div>`);
    await page.addScriptTag({ content: fixture.bundle });
    const pane = page.getByTestId("pane");
    await expect(pane).toBeVisible();
    await page.evaluate((selectionInput) => {
      const root = window.document.querySelector<HTMLElement>(
        '[data-testid="pane"]',
      );
      const start = root?.querySelector(
        `p[data-line="${selectionInput.first}"]`,
      )?.firstChild;
      const end = root?.querySelector(
        `p[data-line="${selectionInput.last}"]`,
      )?.firstChild;
      if (
        root === null ||
        start === null ||
        start === undefined ||
        end === null ||
        end === undefined
      ) {
        throw new Error("Selection fixture did not mount");
      }
      const range = window.document.createRange();
      range.setStart(start, 0);
      range.setEnd(
        end,
        selectionInput.endOffset ?? end.textContent?.length ?? 0,
      );
      const selection = window.document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rect = root.getBoundingClientRect();
      if (selectionInput.pointer) {
        root.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            clientX: rect.right - 20,
            clientY: rect.top + 110,
          }),
        );
      } else {
        root.dispatchEvent(
          new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }),
        );
      }
    }, selectionCase);
    const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
    if (name === "offscreen") {
      await expect(toolbar).toHaveCount(0);
      return;
    }
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS("position", "fixed");
    await expect
      .poll(async () => (await toolbar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(200);
    const geometry = await page.evaluate((usePointer) => {
      const paneElement = window.document.querySelector<HTMLElement>(
        '[data-testid="pane"]',
      );
      const toolbarElement =
        window.document.querySelector<HTMLElement>('[role="toolbar"]');
      if (paneElement === null || toolbarElement === null) {
        throw new Error("Selection geometry nodes missing");
      }
      const bounds = paneElement.getBoundingClientRect();
      const bar = toolbarElement.getBoundingClientRect();
      const range = window.document.getSelection()?.getRangeAt(0);
      const visibleLines = Array.from(range?.getClientRects() ?? []).filter(
        (rect) =>
          rect.top < bounds.bottom &&
          rect.bottom > bounds.top &&
          rect.right > bounds.left &&
          rect.left < bounds.right,
      );
      const end = visibleLines.at(-1);
      const y = usePointer ? bounds.top + 110 : end?.bottom;
      return {
        pane: bounds.toJSON(),
        toolbar: bar.toJSON(),
        y,
        selectionEnd: range?.getBoundingClientRect().bottom,
        headerBottom: window.document
          .querySelector("header")
          ?.getBoundingClientRect().bottom,
      };
    }, selectionCase.pointer);
    expect(geometry.toolbar.left).toBeGreaterThanOrEqual(geometry.pane.left);
    expect(geometry.toolbar.right).toBeLessThanOrEqual(geometry.pane.right);
    expect(geometry.toolbar.top).toBeGreaterThanOrEqual(geometry.pane.top);
    expect(geometry.toolbar.top).toBeGreaterThanOrEqual(
      geometry.headerBottom ?? 0,
    );
    expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.pane.bottom);
    expect(geometry.y).toBeDefined();
    const y = geometry.y ?? 0;
    expect(
      Math.min(
        Math.abs(geometry.toolbar.top - y),
        Math.abs(geometry.toolbar.bottom - y),
      ),
    ).toBeLessThanOrEqual(40);
    if (name === "clippedEnd") {
      expect(geometry.selectionEnd).toBeGreaterThan(
        geometry.pane.bottom + geometry.pane.height,
      );
    }
  });
}
