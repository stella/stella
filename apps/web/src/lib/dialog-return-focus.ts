/** Captured at the opening action, before popup focus moves into a portal. */
export const captureDialogReturnFocus = (opener?: HTMLElement) => {
  if (typeof document === "undefined") {
    return { current: null };
  }
  const activeElement = opener ?? document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return { current: null };
  }
  // A menu action disappears as soon as its dialog opens. Return to the
  // menu's trigger instead of retaining a detached menu item.
  const menu = activeElement.closest('[role="menu"]');
  if (menu?.id) {
    const trigger = [...document.querySelectorAll("[aria-controls]")].find(
      (element) =>
        element.getAttribute("aria-controls")?.split(/\s+/u).includes(menu.id),
    );
    if (trigger instanceof HTMLElement) {
      return { current: trigger };
    }
  }
  return { current: activeElement };
};
