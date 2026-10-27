import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { birthDateDraft } from "./person-details-fields.logic";
import type { BirthDateDraft } from "./person-details-fields.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });
const { act, cleanup, fireEvent, render, screen, within } =
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

type FixtureProps = { initial?: string[]; initialBirthDate?: BirthDateDraft };

const Fixture = ({ initial, initialBirthDate }: FixtureProps) => {
  const [birthDate, setBirthDate] = useState(
    initialBirthDate ?? birthDateDraft(null),
  );
  const [codes, setCodes] = useState<string[]>(initial ?? []);
  return (
    <PersonDetailsFields
      birthDate={birthDate}
      nationalityCodes={codes}
      onBirthDateChange={setBirthDate}
      onNationalityCodesChange={setCodes}
    />
  );
};

type MountOptions = FixtureProps & { locale?: string };

const mount = async ({
  initial,
  initialBirthDate,
  locale = "en",
}: MountOptions = {}) =>
  act(async () => {
    render(
      <IntlProvider
        locale={locale}
        messages={locale === "ar" ? arabicMessages : messages}
        timeZone="UTC"
      >
        <FormattingProvider locale={locale} timeZone="UTC">
          <Fixture
            {...(initial === undefined ? {} : { initial })}
            {...(initialBirthDate === undefined ? {} : { initialBirthDate })}
          />
        </FormattingProvider>
      </IntlProvider>,
    );
  });

const searchInput = () =>
  screen.getByRole("combobox", {
    name: messages.contacts.fields.nationalities,
  });

test("the country list is closed until the field is focused", async () => {
  await mount();
  expect(screen.queryByRole("listbox")).toBeNull();
  await act(async () => {
    searchInput().focus();
    fireEvent.focus(searchInput());
  });
  expect(
    within(screen.getByRole("listbox")).getAllByRole("option").length,
  ).toBeGreaterThan(10);
});

test("typing filters the list and selecting adds a removable chip", async () => {
  await mount();
  await act(async () => {
    fireEvent.focus(searchInput());
    fireEvent.change(searchInput(), { target: { value: "Slovak" } });
  });
  const options = within(screen.getByRole("listbox")).getAllByRole("option");
  expect(options).toHaveLength(1);
  const option = options.at(0);
  if (!option) {
    throw new Error("Expected the filtered nationality option");
  }
  expect(option.textContent).toContain("Slovakia");
  await act(async () => {
    fireEvent.click(option);
  });
  const chip = document.querySelector('[data-slot="combobox-chip"]');
  expect(chip?.textContent).toContain("Slovakia");
  const removeButton = document.querySelector(
    '[data-slot="combobox-chip-remove"]',
  );
  if (!removeButton) {
    throw new Error("Expected the selected nationality remove button");
  }
  await act(async () => {
    fireEvent.click(removeButton);
  });
  expect(document.querySelector('[data-slot="combobox-chip"]')).toBeNull();
});

test("existing nationalities render as chips while the list is closed", async () => {
  await mount({ initial: ["CZ", "PL"] });
  const chips = [...document.querySelectorAll('[data-slot="combobox-chip"]')];
  expect(chips.map((chip) => chip.textContent)).toEqual([
    expect.stringContaining("Czechia"),
    expect.stringContaining("Poland"),
  ]);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("full birth dates use the calendar and preserve the stored date precision", async () => {
  await mount({
    initialBirthDate: birthDateDraft({
      precision: "day",
      year: 1984,
      month: 3,
      day: 12,
    }),
  });
  expect(
    screen.queryByPlaceholderText(messages.contacts.fields.day),
  ).toBeNull();
  expect(
    screen.queryByPlaceholderText(messages.contacts.fields.month),
  ).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Date of birth/u }));
  });
  const date = screen.getByRole("textbox", { name: /Date of birth/u });
  expect(date).toHaveProperty("value", "1984-03-12");
  await act(async () => {
    fireEvent.change(date, { target: { value: "2000-02-29" } });
  });
  await act(async () => {
    fireEvent.keyDown(date, { key: "Enter" });
  });
  await act(async () => {
    fireEvent.change(
      screen.getByRole("combobox", { name: messages.contacts.datePrecision }),
      { target: { value: "month" } },
    );
  });
  expect(
    screen.getByRole("textbox", { name: messages.contacts.fields.year }),
  ).toHaveProperty("value", "2000");
  expect(
    screen.getByRole("textbox", { name: messages.contacts.fields.month }),
  ).toHaveProperty("value", "2");
});

test("empty birth dates start with a calendar while partial dates remain editable", async () => {
  await mount();
  expect(
    screen.getByRole("button", { name: /Date of birth/u }).textContent,
  ).toContain(messages.common.selectDate);
  await act(async () => {
    fireEvent.change(
      screen.getByRole("combobox", { name: messages.contacts.datePrecision }),
      { target: { value: "year" } },
    );
  });
  const year = screen.getByRole("textbox", {
    name: messages.contacts.fields.year,
  });
  await act(async () => {
    fireEvent.change(year, { target: { value: "١٩٨٤" } });
  });
  expect(year).toHaveProperty("value", "1984");
  expect(
    screen.queryByRole("textbox", { name: messages.contacts.fields.month }),
  ).toBeNull();
});

test.each(["en", "ar"])(
  "the birth-date calendar rejects future dates in %s",
  async (locale) => {
    await mount({ locale });
    const catalog = locale === "ar" ? arabicMessages : messages;
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(catalog.common.anonymizationLabels.dateOfBirth, "u"),
        }),
      );
    });
    const date = screen.getByRole("textbox", {
      name: catalog.common.anonymizationLabels.dateOfBirth,
    });
    await act(async () => {
      fireEvent.change(date, { target: { value: "9999-01-01" } });
    });
    expect(date.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(
      catalog.common.datePicker.outOfRange,
    );
  },
);
