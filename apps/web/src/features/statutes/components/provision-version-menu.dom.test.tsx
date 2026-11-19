import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ProvisionHistoryWalk } from "@/features/statutes/queries/provision-history";
import type { PublicStatuteVersion } from "@/features/statutes/queries/statutes";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ProvisionVersionMenu } = await import("./provision-version-menu");
const { provisionHistoryWalkOptions } =
  await import("@/features/statutes/queries/provision-history");
const en = (await import("@/i18n/langs/en.json")).default;
const cs = (await import("@/i18n/langs/cs.json")).default;

type ProvisionHistoryItem = ProvisionHistoryWalk["items"][number];

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => unregisterDomEnvironment());

const ANCHOR = "par_240";
const id = (index: number) =>
  `0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d${String(index).padStart(2, "0")}`;

const version = ({
  index,
  validFrom,
  validTo,
  isDefault = false,
  status = "historical",
}: {
  index: number;
  validFrom: string;
  validTo: string | null;
  isDefault?: boolean;
  status?: string;
}): PublicStatuteVersion => ({
  id: toSafeId<"legislationDocument">(id(index)),
  eli: "/eli/cz/sb/2024/998",
  slug: "998-2024-sb-synthetic-procedure-act",
  title: "998/2024 Sb., Synthetic procedure act",
  country: "CZE",
  language: "cs",
  documentType: "act",
  status,
  effectiveDate: "2019-01-01",
  versionValidFrom: validFrom,
  versionValidTo: validTo,
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  sourceUrl: null,
  documentUrl: null,
  isDefault,
  amendedBy: null,
  changes: null,
});

// Newest first, as the version list orders them. Today the act is in force
// in the 2026 consolidation; two consolidations are published ahead.
const V_2100 = version({
  index: 9,
  validFrom: "2100-01-01",
  validTo: null,
  status: "current",
});
const V_2099 = version({
  index: 8,
  validFrom: "2099-01-01",
  validTo: "2100-01-01",
  status: "current",
});
const V_2026 = version({
  index: 7,
  validFrom: "2026-01-01",
  validTo: "2099-01-01",
  status: "current",
  isDefault: true,
});
const V_2025 = version({
  index: 6,
  validFrom: "2025-01-01",
  validTo: "2026-01-01",
});
const V_2024 = version({
  index: 5,
  validFrom: "2024-01-01",
  validTo: "2025-01-01",
});
const V_2023 = version({
  index: 4,
  validFrom: "2023-01-01",
  validTo: "2024-01-01",
});
const V_2022 = version({
  index: 3,
  validFrom: "2022-01-01",
  validTo: "2023-01-01",
});
const V_2021 = version({
  index: 2,
  validFrom: "2021-01-01",
  validTo: "2022-01-01",
});
const V_2020 = version({
  index: 1,
  validFrom: "2020-01-01",
  validTo: "2021-01-01",
});
const V_2019 = version({
  index: 0,
  validFrom: "2019-01-01",
  validTo: "2020-01-01",
});
const VERSIONS = [
  V_2100,
  V_2099,
  V_2026,
  V_2025,
  V_2024,
  V_2023,
  V_2022,
  V_2021,
  V_2020,
  V_2019,
];

const historyVersion = (of: PublicStatuteVersion) => ({
  country: of.country,
  slug: of.slug,
  sourceUrl: of.sourceUrl,
  documentId: of.id,
  allowsDerivedAi: true,
  versionValidFrom: of.versionValidFrom,
  versionValidTo: of.versionValidTo,
  expressionKind: of.expressionKind,
  windowDisposition: of.windowDisposition,
  windowDispositionBasis: of.windowDispositionBasis,
});
const found = (
  of: PublicStatuteVersion,
  wordingChange: Extract<
    ProvisionHistoryItem,
    { status: "found" }
  >["wordingChange"],
): ProvisionHistoryItem => ({
  ...historyVersion(of),
  status: "found",
  wordingChange,
  text: `§ 240 in ${of.versionValidFrom ?? ""}`,
  governingText: [],
});

// What the server says of each consolidation's § 240 against the one before
// it; 2020 and 2019 do not carry it, so the history leaves them out.
const HISTORY = {
  complete: true,
  items: [
    found(V_2100, "changed"),
    found(V_2099, "unchanged"),
    found(V_2026, "unchanged"),
    found(V_2025, "unchanged"),
    found(V_2024, "changed"),
    found(V_2023, "unknown"),
    { ...historyVersion(V_2022), status: "unavailable" },
    found(V_2021, "added"),
  ],
} satisfies ProvisionHistoryWalk;

const renderMenu = ({
  locale = "en",
  messages = en,
  versions = VERSIONS,
}: {
  locale?: string;
  messages?: typeof en;
  versions?: readonly PublicStatuteVersion[];
} = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    provisionHistoryWalkOptions({ anchor: ANCHOR, documentId: V_2026.id })
      .queryKey,
    HISTORY,
  );
  const opened: string[] = [];
  const compared: [string, string][] = [];
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <FormattingProvider locale={locale} timeZone="UTC">
          <ProvisionVersionMenu
            currentVersionId={V_2026.id}
            historyAnchor={{ type: "resolved", anchor: ANCHOR }}
            onCompare={() => undefined}
            onCompareWording={(base, previous) => {
              compared.push([base.id, previous.id]);
            }}
            onVersionChange={(documentId) => {
              opened.push(documentId);
            }}
            versions={versions}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { compared, opened, view };
};

// Closed, the menu is its trigger alone, named by the version on screen.
const openMenu = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole("button"));
  const list = document.body.querySelector("ol");
  if (list === null) {
    throw new Error("Expected the version list");
  }
  return list;
};

const rowTexts = (list: HTMLElement) =>
  [...list.children]
    .filter((child) => child.tagName === "LI")
    .map((row) => row.querySelector("button")?.textContent ?? "");

test("a row starts only where the provision's wording changed", () => {
  const { view } = renderMenu();
  const list = openMenu(view);

  expect(rowTexts(list)).toEqual([
    "In force from Jan 1, 2100Changed",
    "Jan 1, 2024 – present · unchanged through 3 versions of the actIn force · Changedalso from Jan 1, 2099",
    "Jan 1, 2023 – Dec 31, 2023",
    `Jan 1, 2022 – Dec 31, 2022${en.statutes.provisionTextUnavailable}`,
    "Jan 1, 2021 – Dec 31, 2021New provision",
    "Jan 1, 2019 – Dec 31, 2020Not in these 2 versions of the act",
  ]);
});

test("a grouped row lists the act's versions inside it from a keyboard-reachable disclosure", () => {
  const { opened, view } = renderMenu();
  openMenu(view);
  const disclosure = view.getByRole("button", {
    name: "Show the versions of the act for Jan 1, 2024 – present",
  });
  expect(disclosure.tagName).toBe("BUTTON");
  disclosure.focus();
  expect(document.activeElement).toBe(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(disclosure);

  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  const row = disclosure.closest("li");
  if (row === null) {
    throw new Error("Expected the grouped row");
  }
  const members = within(row).getAllByRole("listitem");
  expect(members.map((member) => member.textContent)).toEqual([
    "Jan 1, 2099 – Dec 31, 2099",
    "Jan 1, 2026 – Dec 31, 2098",
    "Jan 1, 2025 – Dec 31, 2025",
    "Jan 1, 2024 – Dec 31, 2024",
  ]);
  // The version on screen is marked and cannot be reopened; another one
  // inside the run opens.
  const onScreen = within(row).getByRole("button", {
    name: "Jan 1, 2026 – Dec 31, 2098",
  });
  expect(onScreen.getAttribute("aria-current")).toBe("true");
  fireEvent.click(
    within(row).getByRole("button", { name: "Jan 1, 2025 – Dec 31, 2025" }),
  );
  expect(opened).toEqual([V_2025.id]);
});

test("comparing a changed row sets its wording beside the one before the change", () => {
  const { compared, view } = renderMenu();
  openMenu(view);
  const compares = view.getAllByRole("button", {
    name: en.statutes.compareWithPreviousWording,
  });

  // The coming change and the run in force; the others did not start with a
  // change there is a previous wording for.
  expect(compares).toHaveLength(2);
  fireEvent.click(compares[1] ?? document.body);

  expect(compared).toEqual([[V_2026.id, V_2023.id]]);
});

test("the switch restores every version of the act, one row each", () => {
  const { view } = renderMenu();
  openMenu(view);
  const toggle = view.getByRole("switch", {
    name: en.statutes.provisionVersionsAll,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  // The whole row is the switch's label, so its name flips it.
  fireEvent.click(view.getByText(en.statutes.provisionVersionsAll));

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  const list = document.body.querySelector("ol");
  expect(list?.querySelectorAll(":scope > li")).toHaveLength(VERSIONS.length);
  expect(
    view.queryByRole("button", {
      name: en.statutes.compareWithPreviousWording,
    }),
  ).toBeNull();
});

test("an in-force version of the act shows its change counts once", () => {
  const changed = VERSIONS.map((entry) =>
    entry.id === V_2026.id
      ? {
          ...entry,
          changes: {
            provisions: { changed: 2, added: 1, removed: 0 },
            words: { inserted: 40, deleted: 12 },
          },
        }
      : entry,
  );
  const { view } = renderMenu({ versions: changed });
  openMenu(view);
  fireEvent.click(view.getByText(en.statutes.provisionVersionsAll));

  const inForce = view
    .getAllByRole("listitem")
    .find((row) => row.textContent?.startsWith("Jan 1, 2026"));
  expect(inForce).toBeDefined();
  expect(
    inForce?.querySelectorAll('[data-slot="statute-version-changes"]'),
  ).toHaveLength(1);
});

test("the Czech menu counts the versions with the right plural and names the change", () => {
  const { view } = renderMenu({ locale: "cs", messages: cs });
  const list = openMenu(view);
  const rows = rowTexts(list);

  expect(rows.at(1)).toContain("3 znění zákona beze změny");
  expect(rows.at(1)).toContain("Změněno");
  expect(rows.at(-1)).toContain("Není v těchto 2 zněních zákona");
});
