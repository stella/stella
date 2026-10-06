import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { clearLawRecent, recordLawOpen, recordLawSearch } =
  await import("@/lib/law-search-history");
const { LawRecent } = await import("./law-recent");

setSystemTime(new Date("2026-10-05T10:00:00Z"));

beforeEach(() => clearLawRecent());
afterEach(async () => {
  await act(async () => cleanup());
  clearLawRecent();
});
afterAll(async () => {
  setSystemTime();
  await GlobalRegistrator.unregister();
});

const mount = () => {
  const searches: string[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <LawRecent
          onSearch={(query) => {
            searches.push(query);
          }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  return searches;
};

const seedRecent = () => {
  recordLawSearch("synthetic search");
  recordLawOpen({
    kind: "decision",
    id: "synthetic-decision",
    title: "Synthetic decision 1 · Example court",
    path: "/law/cze/cases/synthetic-court/synthetic-decision",
  });
  recordLawOpen({
    kind: "statute",
    id: "synthetic-statute",
    title: "Synthetic statute 2 · Example act",
    path: "/law/cze/statutes/synthetic-statute",
  });
};

const click = async (name: string) =>
  act(async () => fireEvent.click(screen.getByRole("button", { name })));

test("recent filters keep each kind separate and reopen searches and law items", async () => {
  seedRecent();
  const searches = mount();
  expect(
    screen
      .getByRole("link", { name: /Synthetic decision/u })
      .getAttribute("href"),
  ).toBe("/law/cze/cases/synthetic-court/synthetic-decision");
  expect(
    screen
      .getByRole("link", { name: /Synthetic statute/u })
      .getAttribute("href"),
  ).toBe("/law/cze/statutes/synthetic-statute");

  await click(messages.lawHome.recentSearchFilter);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /synthetic search/u })),
  );
  expect(searches).toEqual(["synthetic search"]);

  await click(messages.lawHome.recentCasesFilter);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(
    screen.getByRole("link", { name: /Synthetic decision/u }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /synthetic search/u }),
  ).toBeNull();

  await click(messages.statutes.title);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /Synthetic statute/u })).toBeTruthy();

  await click(messages.common.all);
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(
    screen
      .getByRole("button", { name: messages.common.all })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("recent removal updates every filter and clear persists across remount", async () => {
  seedRecent();
  mount();
  const decision = screen.getByRole("link", { name: /Synthetic decision/u });
  const row = decision.parentElement;
  expect(row).not.toBeNull();
  if (row === null) {
    throw new TypeError("Recent decision must belong to its action row");
  }
  await act(async () =>
    fireEvent.click(
      within(row).getByRole("button", { name: messages.common.remove }),
    ),
  );
  expect(
    screen.queryByRole("link", { name: /Synthetic decision/u }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: /Synthetic statute/u })).toBeTruthy();
  await click(messages.lawHome.recentCasesFilter);
  expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy();
  await click(messages.common.all);
  await click(messages.lawHome.clearRecent);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: /synthetic search/u }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: messages.lawHome.clearRecent }),
  ).toBeNull();
  await act(async () => cleanup());
  mount();
  expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy();
});
