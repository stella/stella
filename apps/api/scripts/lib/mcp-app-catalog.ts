import { panic } from "better-result";
import path from "node:path";

import { UI_LOCALES } from "@stll/locales";

import type en from "../../../web/src/i18n/langs/en.json";

type Catalog = typeof en;
type CatalogKey =
  | {
      [Namespace in keyof Catalog]: {
        [
          Key in keyof Catalog[Namespace]
        ]: Catalog[Namespace][Key] extends string
          ? `${Namespace}.${Key & string}`
          : never;
      }[keyof Catalog[Namespace]];
    }[keyof Catalog]
  | `caseLaw.courtTiers.${keyof Catalog["caseLaw"]["courtTiers"]}`
  | `caseLaw.columns.${keyof Catalog["caseLaw"]["columns"]}`
  | `caseLaw.sort.${keyof Catalog["caseLaw"]["sort"]}`
  | `common.datePicker.${keyof Catalog["common"]["datePicker"]}`;

// Shared wording is projected from the product catalogs, including every locale.
export const MCP_APP_MESSAGE_KEYS = {
  constitutional: "caseLaw.courtTiers.constitutional",
  supreme: "caseLaw.courtTiers.supreme",
  regional: "caseLaw.courtTiers.regional",
  other: "caseLaw.courtTiers.other",
  title: "common.caseLaw",
  relevance: "caseLaw.sort.relevance",
  sort: "common.sort",
  newest: "caseLaw.sort.newest",
  search: "navigation.search",
  searchPlaceholder: "common.search",
  reset: "common.reset",
  decisions: "common.decisions",
  selectDate: "common.selectDate",
  clearDate: "common.clearDate",
  today: "common.today",
  datePicker: "common.datePicker.label",
  previousMonth: "common.datePicker.previousMonth",
  nextMonth: "common.datePicker.nextMonth",
  previousYear: "common.datePicker.previousYear",
  nextYear: "common.datePicker.nextYear",
  previousDecade: "common.datePicker.previousDecade",
  nextDecade: "common.datePicker.nextDecade",
  court: "common.court",
  country: "common.country",
  date: "common.date",
  reference: "common.reference",
  summary: "caseLaw.columns.summary",
  copy: "common.copy",
  filter: "common.filter",
  all: "common.all",
  next: "common.next",
  loading: "common.loading",
  noResults: "common.noResults",
  retry: "common.retry",
  error: "common.error",
  open: "common.open",
  from: "search.dateFrom",
  to: "search.dateTo",
} as const satisfies Record<string, CatalogKey>;

const readMessage = (catalog: unknown, key: string): string => {
  let value = catalog;
  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) {
      return panic(`MCP app translation is missing: ${key}`);
    }
    value = Reflect.get(value, segment);
  }
  if (typeof value !== "string") {
    return panic(`MCP app translation is not text: ${key}`);
  }
  return value;
};

export const buildMcpAppMessages = async () =>
  Object.fromEntries(
    await Promise.all(
      UI_LOCALES.map(async (locale) => {
        const catalog: unknown = await Bun.file(
          path.resolve(
            import.meta.dirname,
            `../../../web/src/i18n/langs/${locale}.json`,
          ),
        ).json();
        return [
          locale,
          Object.fromEntries(
            Object.entries(MCP_APP_MESSAGE_KEYS).map(([name, key]) => [
              name,
              readMessage(catalog, key),
            ]),
          ),
        ];
      }),
    ),
  );
