import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { PersonDetailsFields } = await import("./person-details-fields");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const Fixture = ({ initial }: { initial?: string[] }) => {
  const [codes, setCodes] = useState<string[]>(initial ?? []);
  return (
    <PersonDetailsFields
      birthDate={{ precision: "year", year: "", month: "", day: "" }}
      nationalityCodes={codes}
      onBirthDateChange={() => undefined}
      onNationalityCodesChange={setCodes}
    />
  );
};

const mount = async (initial?: string[]) =>
  act(async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Fixture {...(initial === undefined ? {} : { initial })} />
        </FormattingProvider>
      </IntlProvider>,
    );
  });

const searchInput = () =>
  screen.getByRole("combobox", { name: messages.contacts.searchCountries });

test("the country list is closed until the field is focused", async () => {
  await mount();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  await act(async () => {
    searchInput().focus();
    fireEvent.focus(searchInput());
  });
  expect(screen.getAllByRole("option").length).toBeGreaterThan(10);
});

test("typing filters the list and selecting adds a removable chip", async () => {
  await mount();
  await act(async () => {
    fireEvent.focus(searchInput());
    fireEvent.change(searchInput(), { target: { value: "Slovak" } });
  });
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(1);
  expect(options[0]?.textContent).toContain("Slovakia");
  await act(async () => {
    fireEvent.click(options[0] as HTMLElement);
  });
  const chip = document.querySelector('[data-slot="combobox-chip"]');
  expect(chip?.textContent).toContain("Slovakia");
  await act(async () => {
    fireEvent.click(
      document.querySelector(
        '[data-slot="combobox-chip-remove"]',
      ) as HTMLElement,
    );
  });
  expect(document.querySelector('[data-slot="combobox-chip"]')).toBeNull();
});

test("existing nationalities render as chips while the list is closed", async () => {
  await mount(["CZ", "PL"]);
  const chips = [...document.querySelectorAll('[data-slot="combobox-chip"]')];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    expect.stringContaining("Czechia"),
    expect.stringContaining("Poland"),
  ]);
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});
