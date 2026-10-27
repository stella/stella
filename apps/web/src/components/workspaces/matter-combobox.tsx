import { useMemo, useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { SearchIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import {
  chatActivityByWorkspace,
  selectPinnedThenRecentWorkspaces,
} from "@/components/app-sidebar.logic";
import { MatterOptionLabel } from "@/components/matter-option-label";
import {
  groupMatterOptions,
  isBrowsingMatters,
  matchesMatterOption,
  MATTER_OPTION_GROUP,
  MATTER_PICKER_RECENT_LIMIT,
} from "@/components/workspaces/matter-combobox.logic";
import type {
  MatterOptionGroup,
  MatterOptionGroupKey,
} from "@/components/workspaces/matter-combobox.logic";
import {
  groupedChatThreadsOptions,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { usePinnedStore } from "@/lib/pinned-store";
import { useQueryView } from "@/lib/use-query-view";
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

const NO_WORKSPACES: readonly never[] = [];

const GROUP_LABEL = {
  [MATTER_OPTION_GROUP.recent]: "navigation.recents",
  [MATTER_OPTION_GROUP.all]: "inspector.matterPicker.allMatters",
} as const satisfies Record<MatterOptionGroupKey, TranslationKey>;

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
};

/**
 * Which matter an action lands in.
 *
 * One control wherever the app asks that question — uploading a document,
 * pinning case law — so the list, the search and the client line read the same
 * everywhere. Filtering is client-side over the navigation list the sidebar
 * already holds, so the popup opens without a round trip. Base UI owns the
 * input text and filters the items it is given, so its empty state appears
 * only when nothing matches. While browsing, the reader's recent matters
 * (pinned first, then by activity, as the sidebar ranks them) lead in their
 * own group; typing collapses the groups into one filtered list.
 */
export const MatterCombobox = ({
  activeOrganizationId,
  userId,
  id,
  onChange,
  value,
}: MatterComboboxProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState(value?.name ?? "");
  const pinnedOrder = usePinnedStore((state) => state.pinnedOrder);
  const {
    data: navigation,
    error,
    isPending,
    refetch,
  } = useQuery(
    workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  // Chat activity only reorders the recent group; without it the group falls
  // back to matter activity, so its failure is not the picker's to show.
  const groupedThreadsQuery = useInfiniteQuery(
    groupedChatThreadsOptions({ activeOrganizationId, userId }),
  );
  const groupedThreadsView = useQueryView(groupedThreadsQuery);
  const chatHistory =
    groupedThreadsView.type === "items" ? groupedThreadsView.items : undefined;
  const browsing = isBrowsingMatters({
    query,
    selectedName: value?.name ?? null,
  });
  // Base UI copies `items` into its own state whenever the prop's identity
  // changes, so a list rebuilt on every render re-renders the combobox
  // forever. Memoized on the cached query results (stable references) and
  // the pinned order, the list changes only when its inputs do.
  const items = useMemo(() => {
    // Nothing to offer until the navigation list has loaded.
    const workspaces =
      navigation === undefined ? NO_WORKSPACES : navigation.workspaces;
    const matters = workspaces.map(toMatterOption);
    if (!browsing) {
      return matters;
    }
    const recentIds = selectPinnedThenRecentWorkspaces({
      chatActivityByWorkspaceId: chatActivityByWorkspace(
        mergeGroupedChatThreadPages(chatHistory?.pages),
      ),
      limit: MATTER_PICKER_RECENT_LIMIT,
      pinnedOrder,
      workspaces,
    }).map((matter) => matter.id);
    return groupMatterOptions({ matters, recentIds });
  }, [browsing, chatHistory, navigation, pinnedOrder]);

  return (
    <div className="flex flex-col gap-2">
      <Combobox
        // While the input still shows the chosen matter's name, Base UI
        // skips the filter and keeps every matter in view.
        // A callback, so the combobox takes its item type from `items`.
        filter={(matter, typed) => matchesMatterOption(matter, typed)}
        isItemEqualToValue={(item, selected) => item.id === selected.id}
        items={items}
        itemToStringLabel={(matter) => matter.name}
        onInputValueChange={setQuery}
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
            {(entry: MatterOption | MatterOptionGroup<MatterOption>) =>
              "items" in entry ? (
                <ComboboxGroup items={entry.items} key={entry.value}>
                  <ComboboxGroupLabel>
                    {t(GROUP_LABEL[entry.value])}
                  </ComboboxGroupLabel>
                  <ComboboxCollection>
                    {(matter: MatterOption) => (
                      <ComboboxItem key={matter.id} value={matter}>
                        <MatterOptionLabel matter={matter} />
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              ) : (
                <ComboboxItem key={entry.id} value={entry}>
                  <MatterOptionLabel matter={entry} />
                </ComboboxItem>
              )
            }
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
