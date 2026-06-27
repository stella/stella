import { IntlProvider } from "use-intl";

import { FieldValue } from "@stll/workspace-ui/field-value";
import { PropertyIcon } from "@stll/workspace-ui/property-icon";
import type {
  GenericProperty,
  OptionColor,
  WorkspaceFieldContent,
} from "@stll/workspace-ui/types";

// Mock columns + rows shaped to the real workspace display types, rendered
// through the SAME `FieldValue` the app's review table and its loading skeleton
// use. A UX change to any cell renderer updates all three surfaces at once.
type PreviewColumn = GenericProperty & {
  id: string;
  label: string;
  iconType: "text" | "date" | "single-select";
};

type PreviewRow = { id: string; cells: WorkspaceFieldContent[] };

const RISK_OPTIONS: { value: string; color: OptionColor }[] = [
  { value: "Low", color: "green" },
  { value: "Medium", color: "amber" },
  { value: "High", color: "red" },
];

const COLUMNS: readonly PreviewColumn[] = [
  {
    id: "document",
    label: "Document",
    iconType: "text",
    content: { type: "text" },
  },
  {
    id: "parties",
    label: "Parties",
    iconType: "text",
    content: { type: "text" },
  },
  {
    id: "law",
    label: "Governing law",
    iconType: "text",
    content: { type: "text" },
  },
  { id: "term", label: "Term", iconType: "date", content: { type: "date" } },
  {
    id: "risk",
    label: "Risk",
    iconType: "single-select",
    content: { type: "single-select", options: RISK_OPTIONS },
  },
];

const text = (value: string): WorkspaceFieldContent => ({
  type: "text",
  version: 1,
  value,
});

const date = (value: string): WorkspaceFieldContent => ({
  type: "date",
  version: 1,
  value,
});

const risk = (value: string): WorkspaceFieldContent => ({
  type: "single-select",
  version: 1,
  value,
});

const PENDING: WorkspaceFieldContent = { type: "pending", version: 1 };

const ROWS: readonly PreviewRow[] = [
  {
    id: "r1",
    cells: [
      text("MSA — Acme Corp"),
      text("Acme · Northwind"),
      text("England & Wales"),
      date("2026-03-31"),
      risk("Low"),
    ],
  },
  {
    id: "r2",
    cells: [
      text("NDA — Globex"),
      text("Globex · stella"),
      text("Delaware"),
      date("2026-09-30"),
      risk("Medium"),
    ],
  },
  {
    id: "r3",
    cells: [
      text("DPA — Initech"),
      text("Initech · Hooli"),
      text("Germany"),
      date("2026-12-31"),
      PENDING,
    ],
  },
  {
    id: "r4",
    cells: [
      text("SoW — Soylent"),
      text("Soylent · Umbrella"),
      text("Czechia"),
      date("2026-06-30"),
      PENDING,
    ],
  },
];

type ProviderMessages = NonNullable<
  Parameters<typeof IntlProvider>[0]["messages"]
>;

const PREVIEW_MESSAGE_VALUES = {
  common: { empty: "—" },
  workspaces: {
    fields: {
      calculating: "Extracting…",
      errored: "Error",
      formatNotSupported: "—",
    },
  },
};

// SAFETY: this isolated preview subtree intentionally supplies its own message
// set (the workspace field strings FieldValue reads) rather than the landing's
// registered Messages shape. The cast is confined to this provider boundary,
// mirroring the app's own i18n provider boundary in app-providers.tsx.
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- preview i18n provider boundary; messages drive FieldValue's workspace strings, not the landing's registered Messages
const PREVIEW_MESSAGES = PREVIEW_MESSAGE_VALUES as ProviderMessages;

export const PreviewTable = () => (
  <IntlProvider locale="en" messages={PREVIEW_MESSAGES} timeZone="UTC">
    <div className="pointer-events-none flex h-full flex-col gap-2 text-[0.6rem]">
      <div
        className="grid items-center gap-x-3 pb-1.5"
        style={{
          gridTemplateColumns: GRID,
          borderBottom: `1px solid ${muted(28)}`,
        }}
      >
        {COLUMNS.map((col) => (
          <span
            key={col.id}
            className="flex min-w-0 items-center gap-1 font-medium tracking-wide"
            style={{ color: muted(70) }}
          >
            <PropertyIcon type={col.iconType} className="size-3" />
            <span className="truncate">{col.label}</span>
          </span>
        ))}
      </div>

      {ROWS.map((row) => (
        <div
          key={row.id}
          className="grid items-center gap-x-3"
          style={{ gridTemplateColumns: GRID }}
        >
          {COLUMNS.map((col, c) => (
            <div key={col.id} className="relative flex min-w-0 items-center">
              <FieldValue
                content={row.cells[c]}
                property={col}
                variant="table"
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  </IntlProvider>
);

const GRID = "1.7fr 1.1fr 1.1fr 0.6fr 0.7fr";

const muted = (opacity: number) =>
  `color-mix(in srgb, var(--muted-foreground) ${opacity}%, transparent)`;
