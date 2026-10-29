/** Nested rows own their context actions, including when their menu is absent. */
export const ownsContextMenuTarget = ({
  currentTarget,
  target,
}: {
  currentTarget: unknown;
  target: unknown;
}): boolean => {
  if (!(currentTarget instanceof Element) || !(target instanceof Node)) {
    return false;
  }
  const element = target instanceof Element ? target : target.parentElement;
  return (
    currentTarget.contains(target) &&
    element?.closest("[data-context-menu-target]") ===
      currentTarget.closest("[data-context-menu-target]")
  );
};
