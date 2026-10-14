export const handleReaderBackShortcut = (
  event: Pick<
    KeyboardEvent,
    | "key"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
    | "defaultPrevented"
    | "preventDefault"
  >,
  onBack: () => void,
) => {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  const backShortcut =
    (event.key === "Escape" && !event.altKey) ||
    (event.key === "ArrowLeft" && event.altKey);
  if (!backShortcut) {
    return;
  }
  event.preventDefault();
  onBack();
};
