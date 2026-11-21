import { useTranslations } from "use-intl";

import { UserText } from "@stll/ui/bidi-text";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@stll/ui/menu";
import { TruncatedText } from "@stll/ui/truncated-text";

import { useInspectorGroups } from "@/components/inspector/inspector-group-controls";
import {
  InspectorTabIcon,
  InspectorTabLabel,
  SuggestedReviveTabIcon,
} from "@/components/inspector/inspector-tab-presentation";
import { getInspectorTabSwitcherHandle } from "@/components/inspector/inspector-tab-switcher-handle";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";

/**
 * The phone's tab switcher: the inspector's open tabs, in the rail's order
 * and under the rail's groups, drawn with the rail's icons and labels.
 *
 * The panel mounts this one menu; each tab header renders a trigger for it
 * (`InspectorTabSwitcherTrigger`). Picking a tab swaps the header that was
 * pressed for the picked tab's, so on close the menu hands focus to the
 * trigger now on screen rather than the one it opened from.
 */
export const InspectorTabSwitcherMenu = () => {
  const { menu, triggers } = getInspectorTabSwitcherHandle();
  return (
    <Menu handle={menu}>
      <MenuPopup
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
        finalFocus={() => shownTrigger(triggers) ?? true}
      >
        <InspectorTabSwitcherList />
      </MenuPopup>
    </Menu>
  );
};

/**
 * The registered trigger the reader can see. Inactive file tabs stay
 * mounted, hidden, with their headers, so mounted is not enough.
 */
const shownTrigger = (triggers: ReadonlySet<HTMLElement>) =>
  [...triggers].find(
    (trigger) => trigger.isConnected && trigger.getClientRects().length > 0,
  );

const activateTab = (tabId: string) => {
  const store = useInspectorTabsStore.getState();
  store.setActive(tabId);
  store.setMinimized(false);
};

const InspectorTabSwitcherList = () => {
  const t = useTranslations();
  const activeId = useInspectorTabsStore((s) => s.activeId);
  const suggestion = useInspectorTabsStore((s) => s.reviveSuggestion);
  const reviveSuggestedTab = useInspectorTabsStore((s) => s.reviveSuggestedTab);
  const { visibleGroups, ungroupedTabs } = useInspectorGroups();
  return (
    <>
      <MenuRadioGroup
        onValueChange={(value: unknown) => {
          if (typeof value === "string") {
            activateTab(value);
          }
        }}
        value={activeId}
      >
        {visibleGroups.map(({ group, tabs }) => (
          <MenuGroup key={group.id}>
            <MenuGroupLabel>
              <TruncatedText>
                <UserText>{group.name}</UserText>
              </TruncatedText>
            </MenuGroupLabel>
            {tabs.map((tab) => (
              <InspectorTabSwitcherItem key={tab.id} tab={tab} />
            ))}
          </MenuGroup>
        ))}
        {visibleGroups.length > 0 && ungroupedTabs.length > 0 && (
          <MenuSeparator />
        )}
        {ungroupedTabs.map((tab) => (
          <InspectorTabSwitcherItem key={tab.id} tab={tab} />
        ))}
      </MenuRadioGroup>
      {suggestion !== null && (
        <>
          <MenuSeparator />
          <MenuItem onClick={reviveSuggestedTab}>
            <span className="flex size-4 shrink-0 items-center justify-center">
              <SuggestedReviveTabIcon tab={suggestion} />
            </span>
            <TruncatedText>
              {t("inspector.reopenTab", { name: suggestion.label })}
            </TruncatedText>
          </MenuItem>
        </>
      )}
    </>
  );
};

const InspectorTabSwitcherItem = ({ tab }: { tab: InspectorTab }) => (
  <InspectorTabLabel
    render={(label) => (
      // Picking a tab is the whole errand: the menu closes onto it.
      <MenuRadioItem closeOnClick label={label} value={tab.id}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <InspectorTabIcon tab={tab} />
          </span>
          <TruncatedText>
            <UserText>{label}</UserText>
          </TruncatedText>
        </span>
      </MenuRadioItem>
    )}
    tab={tab}
  />
);
