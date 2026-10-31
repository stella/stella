export type CitationClick = Pick<
  MouseEvent,
  "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** True only for an unmodified primary click; every other gesture stays native. */
export const isPlainPrimaryClick = ({
  altKey,
  button,
  ctrlKey,
  metaKey,
  shiftKey,
}: CitationClick): boolean =>
  button === 0 && !altKey && !ctrlKey && !metaKey && !shiftKey;
