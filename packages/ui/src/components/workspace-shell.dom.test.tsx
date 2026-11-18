import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { WorkspaceShell } = await import("./workspace-shell");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const focusableSelector = "a[href], button, input, [tabindex]";

test("the first tab stop skips the navigation and moves focus into main", () => {
  const view = render(
    <WorkspaceShell
      navigation={{
        content: (
          <nav>
            <a href="/matters">Matters</a>
          </nav>
        ),
        mode: "responsive",
      }}
      skipToContentLabel="Skip to content"
      topBar={() => (
        <header>
          <button type="button">Search</button>
        </header>
      )}
    >
      <article>Content</article>
    </WorkspaceShell>,
  );

  const firstTabStop = [
    ...view.container.querySelectorAll<HTMLElement>(focusableSelector),
  ].find((element) => element.tabIndex >= 0);
  const skipLink = view.getByRole("link", { name: "Skip to content" });
  expect(firstTabStop).toBe(skipLink);

  const main = view.container.querySelector("main");
  expect(main).not.toBeNull();
  expect(skipLink.getAttribute("href")).toBe(`#${main?.id}`);

  fireEvent.click(skipLink);
  expect(document.activeElement).toBe(main);
  // Focus lands without writing a hash into the URL.
  expect(window.location.hash).toBe("");
});

test("renders no skip link when the host gives it no name", () => {
  const view = render(
    <WorkspaceShell
      navigation={{ content: <nav>Navigation</nav>, mode: "responsive" }}
      topBar={() => <header>Header</header>}
    >
      <article>Content</article>
    </WorkspaceShell>,
  );

  expect(
    view.container.querySelector('[data-slot="workspace-shell-skip-link"]'),
  ).toBeNull();
});
