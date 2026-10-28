import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { render, cleanup } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { StatuteVersionChanges } = await import("./statute-version-changes");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const renderRow = (changes: StatuteChangeCounts) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <StatuteVersionChanges changes={changes} />
    </IntlProvider>,
  );

const cells = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll("[data-cell]")].map(
    (cell) => cell.dataset.cell,
  );

test("names only the kinds of change that happened, with a size bar of the words", () => {
  const screen = renderRow({
    provisions: { changed: 3, added: 1, removed: 0 },
    words: { inserted: 120, deleted: 30 },
  });

  expect(screen.container.textContent).toBe(
    "3 provisions changed · 1 provision added",
  );
  const bar = screen.getByRole("img", {
    name: "120 words inserted, 30 words deleted",
  });
  expect(bar.getAttribute("title")).toBe(
    "120 words inserted, 30 words deleted",
  );
  expect(cells(screen.container)).toEqual([
    "inserted",
    "inserted",
    "deleted",
    "empty",
    "empty",
  ]);
});

test("a one-word amendment reads as a changed provision, never as minor", () => {
  const screen = renderRow({
    provisions: { changed: 1, added: 0, removed: 0 },
    words: { inserted: 1, deleted: 1 },
  });

  expect(screen.container.textContent).toBe("1 provision changed");
  expect(screen.container.textContent).not.toMatch(/minor|major/iu);
  expect(
    screen.getByRole("img", { name: "1 word inserted, 1 word deleted" }),
  ).toBeDefined();
});

test("a removed provision alone is named as removed", () => {
  const screen = renderRow({
    provisions: { changed: 0, added: 0, removed: 2 },
    words: { inserted: 0, deleted: 40 },
  });

  expect(screen.container.textContent).toBe("2 provisions removed");
  expect(cells(screen.container)).toEqual([
    "deleted",
    "deleted",
    "empty",
    "empty",
    "empty",
  ]);
});

test("a consolidation with the same wording says so and draws no bar", () => {
  const screen = renderRow({
    provisions: { changed: 0, added: 0, removed: 0 },
    words: { inserted: 0, deleted: 0 },
  });

  expect(screen.container.textContent).toBe(
    messages.statutes.versionChangesNone,
  );
  expect(screen.queryByRole("img")).toBeNull();
});
