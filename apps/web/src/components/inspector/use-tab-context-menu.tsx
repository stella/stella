import { useRef } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  ListXIcon,
  Maximize2Icon,
  PanelRightIcon,
  PenLineIcon,
  XIcon,
  XSquareIcon,
} from "@stll/ui/icons";
import { MenuItem, MenuSeparator } from "@stll/ui/menu";

import { requestInspectorRename } from "@/components/inspector/inspector-actions";
import { useInspectorGroupMenu } from "@/components/inspector/inspector-group-controls";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";

/**
 * Per-tab context menu shared by two surfaces — right-click on
 * the rail icon AND right-click on the visible label inside the
 * ribbon — so the same actions live in one place.
 *
 * `onMaximize` is optional: tab kinds with a main-view counterpart
 * (e.g. a chat tab → `/chat/...`) supply it and the menu surfaces
 * a "Move to main view" item; tabs without one (today: tasks) omit
 * it. The leading "Hide pane" mirrors the rail's top button so the
 * gesture is reachable from either entry point.
 *
 * The close items name what they close: this tab by its label, the
 * others and all by count, so no item leaves the reader guessing.
 */
export const useTabContextMenu = ({
  canRename = true,
  tabId,
  tabLabel,
  onClose,
  onMaximize,
}: {
  canRename?: boolean;
  tabId: string;
  tabLabel: string;
  onClose: () => void;
  onMaximize?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const closeOthers = useInspectorTabsStore((s) => s.closeOthers);
  const closeAll = useInspectorTabsStore((s) => s.closeAll);
  const setMinimized = useInspectorTabsStore((s) => s.setMinimized);
  const tabsCount = useInspectorTabsStore((s) => s.tabs.length);
  const hasOthers = tabsCount > 1;
  const returnFocus = useRef<HTMLElement | null>(null);
  const groupMenu = useInspectorGroupMenu(tabId, returnFocus);

  const menu = useAnchoredMenu({
    returnFocus,
    children: (
      <>
        <MenuItem onClick={() => setMinimized(true)}>
          <PanelRightIcon />
          {t("inspector.hidePane")}
        </MenuItem>
        {onMaximize && (
          <MenuItem onClick={onMaximize}>
            <Maximize2Icon />
            {t("inspector.moveToMain")}
          </MenuItem>
        )}
        <MenuSeparator />
        {groupMenu.items}
        <MenuSeparator />
        {canRename && (
          <MenuItem onClick={() => requestInspectorRename(tabId)}>
            <PenLineIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        <MenuItem onClick={onClose}>
          <XIcon />
          {/* One span, so the rich chunks stay one flex item and keep
              their word spacing; a long label truncates, not the verb. */}
          <span className="min-w-0 truncate">
            {t.rich("inspector.closeTab", {
              bdi: (chunks) => (
                <BidiText className="inline-block max-w-56 truncate align-bottom">
                  {chunks}
                </BidiText>
              ),
              name: tabLabel,
            })}
          </span>
        </MenuItem>
        {hasOthers && (
          <MenuItem onClick={() => closeOthers(tabId)}>
            <ListXIcon />
            {t("inspector.closeOtherTabs", { count: tabsCount - 1 })}
          </MenuItem>
        )}
        {hasOthers && (
          <MenuItem onClick={closeAll}>
            <XSquareIcon />
            {t("inspector.closeAllTabs", { count: tabsCount })}
          </MenuItem>
        )}
      </>
    ),
  });
  return {
    ...menu,
    element: (
      <>
        {menu.element}
        {groupMenu.dialogs}
      </>
    ),
  };
};
