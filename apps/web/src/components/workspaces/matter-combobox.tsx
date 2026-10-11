import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  useComboboxFilter,
} from "@stll/ui/combobox";
import { SearchIcon } from "@stll/ui/icons";

import { selectRecentWorkspaces } from "@/components/app-sidebar.logic";
import { MatterIcon } from "@/components/matter-icon";
import { MatterOptionLabel } from "@/components/matter-option-label";
import { detached } from "@/lib/detached";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

export type MatterOption = {
  clientName: string | null;
  color: string | null;
  id: string;
  name: string;
};

/** A matter from the navigation list, as the combobox offers it. */
export const toMatterOption = (matter: {
  client: { displayName: string } | null;
  color: string | null;
  id: string;
  name: string;
}): MatterOption => ({
  clientName: matter.client?.displayName ?? null,
  color: matter.color,
  id: matter.id,
  name: matter.name,
});

const EMPTY_MATTERS: MatterOption[] = [];

type MatterComboboxProps = {
  /**
   * Whose matters to offer. Passed in rather than read from the authenticated
   * user context: the public case-law page has no such context and still opens
   * this control once a reader is signed in.
   */
  activeOrganizationId: string;
  userId: string;
  /** The control's id, so a label outside it can point at the field. */
  id: string;
  onChange: (matter: MatterOption | null) => void;
  value: MatterOption | null;
  order?: "recent" | "default";
};

/**
 * Which matter an action lands in.
 *
 * One control wherever the app asks that question — uploading a document,
 * pinning case law — so the list, the search and the client line read the same
 * everywhere. Filtering is client-side over the navigation list the sidebar
 * already holds, so the popup opens without a round trip. Base UI owns the
 * input text and filters the items it is given, so its empty state appears
 * only when nothing matches.
 */
export const MatterCombobox = ({
  activeOrganizationId,
  userId,
  id,
  onChange,
  value,
  order = "default",
}: MatterComboboxProps) => {
  const t = useTranslations();
  const { contains } = useComboboxFilter({ sensitivity: "base", value });
  const {
    data: matters = EMPTY_MATTERS,
    error,
    isPending,
    refetch,
  } = useQuery({
    ...workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
    select: (data) => {
      const ordered =
        order === "recent"
          ? selectRecentWorkspaces({
              activeWorkspaceId: undefined,
              chatActivityByWorkspaceId: new Map(),
              limit: data.workspaces.length,
              pinnedIds: new Set(),
              workspaces: data.workspaces,
            })
          : data.workspaces;
      return ordered.map(toMatterOption);
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <Combobox
        // A matter matches on its name or its client's, accent- and
        // case-insensitively. While the input still shows the chosen
        // matter's name, the filter keeps every matter in view.
        filter={(matter: MatterOption, query) =>
          contains(matter, query, matterName) ||
          contains(matter, query, matterClientName)
        }
        isItemEqualToValue={(item, selected) => item.id === selected.id}
        items={matters}
        itemToStringLabel={(matter) => matter.name}
        onValueChange={(matter) => onChange(matter)}
        value={value}
      >
        <ComboboxInput
          id={id}
          placeholder={t("common.selectAMatter")}
          showClear={value !== null}
          startAddon={
            value === null ? (
              <SearchIcon />
            ) : (
              <MatterIcon matter={{ id: value.id, color: value.color }} />
            )
          }
        />
        <ComboboxPopup>
          <ComboboxList>
            {(matter: MatterOption) => (
              <ComboboxItem key={matter.id} value={matter}>
                <MatterOptionLabel matter={matter} />
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
      {isPending && (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      )}
      {error !== null && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{t("errors.actionFailed")}</span>
          <Button
            onClick={() => detached(refetch(), "matter-combobox.retry")}
            size="xs"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
    </div>
  );
};

function matterName(matter: MatterOption): string {
  return matter.name;
}

function matterClientName(matter: MatterOption): string {
  return matter.clientName ?? "";
}
