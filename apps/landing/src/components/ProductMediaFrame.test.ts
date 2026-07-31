import { expect, test } from "bun:test";

const componentPath = new URL("ProductMediaFrame.astro", import.meta.url);

test("editor media is static on mobile and interactive on larger viewports", async () => {
  const component = await Bun.file(componentPath).text();

  expect(component).toContain(
    'class="absolute inset-0 sm:hidden" data-editor-preview="static"',
  );
  expect(component).toContain(
    'class="absolute inset-0 hidden sm:block"\n          data-editor-preview="interactive"',
  );
  expect(component).toContain('<EditorLiveDemoShell client:only="react" />');
});
