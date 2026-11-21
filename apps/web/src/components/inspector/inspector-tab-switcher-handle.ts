import { MenuCreateHandle } from "@stll/ui/menu";

type InspectorTabSwitcherHandle = {
  /** Joins every tab header's trigger to the one menu the panel mounts. */
  menu: ReturnType<typeof MenuCreateHandle>;
  /** The mounted triggers, so the menu can return focus to the one on screen
   *  after a switch replaced the header it opened from. */
  triggers: Set<HTMLElement>;
};

let handle: InspectorTabSwitcherHandle | undefined;

/**
 * The inspector's tab switcher, one per app like the inspector's tab store:
 * the panel mounts its menu, and every tab header, wherever it renders,
 * opens that menu.
 */
export const getInspectorTabSwitcherHandle = () => {
  handle ??= { menu: MenuCreateHandle(), triggers: new Set() };
  return handle;
};
