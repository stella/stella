import { expect, test } from "@playwright/test";

import { findDoubledChromeDividers } from "../helpers/chrome-divider";

test.use({ storageState: { cookies: [], origins: [] } });

// The shell's two slots as WorkspaceShell renders them, with the chrome's
// divider drawn by the top bar and `page` as the routed content.
const shell = (page: string) => `
  <style>
    body { margin: 0; }
    .line { border: 0 solid #d4d4d8; }
  </style>
  <main style="display: flex; flex-direction: column; height: 100vh">
    <div data-slot="workspace-shell-top-bar">
      <header class="line" style="height: 48px; border-bottom-width: 1px">
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

  expect(await findDoubledChromeDividers(page)).toEqual(["div.line.settings"]);
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

  expect(await findDoubledChromeDividers(page)).toEqual(["section.line.pane"]);
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

  expect(await findDoubledChromeDividers(page)).toEqual([]);
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

  expect(await findDoubledChromeDividers(page)).toEqual([]);
});

test("refuses to pass a page that has no workspace shell", async ({ page }) => {
  await page.setContent(`<div style="border-top: 1px solid black">Page</div>`);

  await expect(findDoubledChromeDividers(page)).rejects.toThrow(
    "No workspace shell",
  );
});
