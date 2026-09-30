import { expect, test } from "@playwright/test";

import { findChromeDividerProblems } from "../helpers/chrome-divider";

test.use({ storageState: { cookies: [], origins: [] } });

// The shell's two slots as WorkspaceShell renders them, with the chrome's
// divider drawn by the top bar and `page` as the routed content.
const shell = (page: string, headerBorder = "border-bottom-width: 1px") => `
  <style>
    body { margin: 0; }
    .line { border: 0 solid #d4d4d8; }
  </style>
  <main style="display: flex; flex-direction: column; height: 100vh">
    <div data-slot="workspace-shell-top-bar">
      <header class="line" style="height: 48px; ${headerBorder}">
        Breadcrumb
      </header>
    </div>
    <div data-slot="workspace-shell-content" style="flex: 1">${page}</div>
  </main>
`;

test("flags a page root that draws its own top border under the chrome", async ({
  page,
}) => {
  await page.setContent(
    shell(
      `<div class="line settings" style="border-top-width: 1px">Page</div>`,
    ),
  );

  expect(await findChromeDividerProblems(page)).toEqual(["div.line.settings"]);
});

test("flags a nested pane that lands flush on the divider", async ({
  page,
}) => {
  await page.setContent(
    shell(`
      <div style="display: flex">
        <nav style="width: 200px">Nav</nav>
        <section class="line pane" style="border-top-width: 1px">Body</section>
      </div>
    `),
  );

  expect(await findChromeDividerProblems(page)).toEqual(["section.line.pane"]);
});

test("accepts a page whose borders sit below the chrome", async ({ page }) => {
  await page.setContent(
    shell(`
      <div style="display: flex; flex-direction: column">
        <div class="line toolbar" style="height: 40px; border-bottom-width: 1px">
          Tabs
        </div>
        <div class="line footer" style="border-top-width: 1px">Footer</div>
        <div style="border-top: 1px solid transparent">Spacer</div>
      </div>
    `),
  );

  expect(await findChromeDividerProblems(page)).toEqual([]);
});

test("accepts a transparent or zero-width top border on the first row", async ({
  page,
}) => {
  await page.setContent(
    shell(`
      <div style="border-top: 1px solid rgba(0, 0, 0, 0)">
        <div class="line" style="border-top-width: 0">Page</div>
      </div>
    `),
  );

  expect(await findChromeDividerProblems(page)).toEqual([]);
});

test("refuses to pass a page that has no workspace shell", async ({ page }) => {
  await page.setContent(`<div style="border-top: 1px solid black">Page</div>`);

  await expect(findChromeDividerProblems(page)).rejects.toThrow(
    "No workspace shell",
  );
});

for (const { name, border } of [
  { name: "missing", border: "border-bottom: none" },
  { name: "transparent", border: "border-bottom: 1px solid transparent" },
  { name: "zero-alpha", border: "border-bottom: 1px solid rgba(0, 0, 0, 0)" },
  { name: "zero-width", border: "border-bottom-width: 0" },
]) {
  test(`flags a ${name} header border even when content has no border`, async ({
    page,
  }) => {
    await page.setContent(shell("<div>Page</div>", border));
    expect(await findChromeDividerProblems(page)).toEqual([
      "Missing visible chrome header bottom border",
    ]);
  });
}

test("rejects a content border as a substitute for the missing header divider", async ({
  page,
}) => {
  await page.setContent(
    shell(
      '<div class="line settings" style="border-top-width: 1px">Page</div>',
      "border-bottom: none",
    ),
  );
  expect(await findChromeDividerProblems(page)).toEqual([
    "Missing visible chrome header bottom border",
    "div.line.settings",
  ]);
});
