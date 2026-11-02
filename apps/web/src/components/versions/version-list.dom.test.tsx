import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { VersionRow } = await import("./version-list");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderRow = (diffLabel?: string) => {
  render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <VersionRow
        author={null}
        createdAt="2026-10-30T10:00:00.000Z"
        diffLabel={diffLabel}
        loadDiff={async () => await Promise.resolve([])}
        title="v1"
      />
    </IntlProvider>,
  );
};

test("a version with an earlier one offers its diff", () => {
  renderRow();
  expect(
    screen.getByRole("button", { name: englishMessages.fileDetail.showDiff }),
  ).toBeDefined();
});

test("the first version names what the toggle really shows", () => {
  renderRow(englishMessages.fileDetail.showText);
  expect(
    screen.getByRole("button", { name: englishMessages.fileDetail.showText }),
  ).toBeDefined();
  expect(
    screen.queryByRole("button", { name: englishMessages.fileDetail.showDiff }),
  ).toBeNull();
});
