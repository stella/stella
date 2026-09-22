/**
 * What the statute list keeps per reader: how the table is arranged in each
 * jurisdiction, and the find over the page on screen. Both are the shared
 * public-law ones, over the statute columns.
 */

import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { usePublicLawFind } from "@/components/public-law-table/use-public-law-find";
import type { PublicLawFind } from "@/components/public-law-table/use-public-law-find";
import { usePublicLawTableLayout } from "@/components/public-law-table/use-public-law-table-layout";
import type { PublicLawTableLayoutStore } from "@/components/public-law-table/use-public-law-table-layout";
import type { TableFindColumnRow } from "@/components/workspaces/table/table-find-bar";
import { StatuteColumnIcon } from "@/features/statutes/components/statute-table";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import {
  DEFAULT_STATUTE_TABLE_LAYOUT,
  STATUTE_COLUMN_IDS,
  STATUTE_COLUMN_LABEL_KEYS,
  statuteTableLayouts,
  StoredStatuteLayoutSchema,
} from "@/features/statutes/statute-columns.logic";
import type { StatuteTableLayout } from "@/features/statutes/statute-columns.logic";
import {
  isFindableStatuteColumn,
  statuteFindRowText,
} from "@/features/statutes/statute-find.logic";
import { readStoredJson } from "@/lib/stored-json";

const STATUTE_LAYOUT_STORE: PublicLawTableLayoutStore<StatuteTableLayout> = {
  storageKey: "statute_table_layout",
  read: (raw) =>
    statuteTableLayouts(readStoredJson(raw, StoredStatuteLayoutSchema) ?? {}),
  defaultLayout: DEFAULT_STATUTE_TABLE_LAYOUT,
};

/** How this browser draws the statute table in a jurisdiction, and how to change it. */
export const useStatuteColumnPreferences = (country: string) =>
  usePublicLawTableLayout(STATUTE_LAYOUT_STORE, country);

type UseStatuteFindOptions = {
  /** The arrangement: a column the reader hid is one a find must not reach. */
  layout: StatuteTableLayout;
  /** The pane a Cmd/Ctrl+F inside belongs to. */
  paneRef: RefObject<HTMLElement | null>;
  statutes: readonly StatuteListItem[];
  /** What the find belongs to: the jurisdiction. */
  surfaceKey: string;
};

export const useStatuteFind = ({
  layout,
  paneRef,
  statutes,
  surfaceKey,
}: UseStatuteFindOptions): PublicLawFind<StatuteListItem> => {
  const t = useTranslations();
  const hidden = new Set(layout.hidden);
  const notSearchable = t("workspaces.views.findColumnNotSearchable");
  const columns: TableFindColumnRow[] = [];
  for (const column of STATUTE_COLUMN_IDS) {
    if (hidden.has(column)) {
      continue;
    }
    columns.push({
      icon: (
        <StatuteColumnIcon className="size-3.5 opacity-70" column={column} />
      ),
      id: column,
      label: t(STATUTE_COLUMN_LABEL_KEYS[column]),
      ...(isFindableStatuteColumn(column)
        ? { searchable: true }
        : { reason: notSearchable, searchable: false }),
    });
  }

  return usePublicLawFind({
    columns,
    paneRef,
    rows: statutes,
    rowText: statuteFindRowText,
    surfaceKey,
  });
};
