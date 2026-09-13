import type { ReactNode } from "react";
import { Fragment } from "react";

import { EyeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";

/** One column a reader may show or hide, however the column came about. */
type ColumnToggleItem = {
  id: string;
  /** Already resolved for the reader's locale. */
  name: string;
  icon: ReactNode;
};

export type ColumnToggleGroup = {
  id: string;
  /** Already resolved for the reader's locale. */
  label: ReactNode;
  columns: readonly ColumnToggleItem[];
};

type ColumnToggleProps = {
  /** The toggleable columns, grouped as the reader thinks of them. */
  groups: readonly ColumnToggleGroup[];
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
};

/**
 * Which columns show.
 *
 * The list is the host's: a matter's metadata, its properties and its AI
 * columns, or a results page's decision columns and its questions. The menu
 * knows only that a column has a name, an icon and an id that is either in
 * the hidden set or not, so every kind of column is toggled the same way.
 */
export const ColumnToggle = ({
  groups,
  hidden,
  onChange,
}: ColumnToggleProps) => {
  const t = useTranslations();
  const toggleColumn = (columnId: string) => {
    onChange(
      hidden.includes(columnId)
        ? hidden.filter((id) => id !== columnId)
        : [...hidden, columnId],
    );
  };
  const populated = groups.filter((group) => group.columns.length > 0);

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.columns")}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <EyeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        {populated.map((group, groupIndex) => (
          <Fragment key={group.id}>
            {groupIndex > 0 && <MenuSeparator />}
            <MenuGroup>
              <MenuGroupLabel>{group.label}</MenuGroupLabel>
              {group.columns.map((column) => (
                <MenuItem
                  closeOnClick={false}
                  key={column.id}
                  onClick={() => toggleColumn(column.id)}
                >
                  {column.icon}
                  <span className="flex-1">{column.name}</span>
                  {!hidden.includes(column.id) && (
                    <span className="text-primary">{"✓"}</span>
                  )}
                </MenuItem>
              ))}
            </MenuGroup>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
};
