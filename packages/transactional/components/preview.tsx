import type React from "react";

/**
 * The inbox preview line: hidden in the opened email, and padded with
 * invisible characters so clients do not fill the preview with body text.
 * `data-skip-in-text` keeps it out of the plain-text part.
 */
export const Preview = ({ children }: Props) => {
  const text = children.slice(0, PREVIEW_MAX_LENGTH);
  return (
    <div style={HIDDEN} data-skip-in-text={true}>
      {text}
      {text.length < PREVIEW_MAX_LENGTH ? (
        <div>{PREVIEW_PADDING.repeat(PREVIEW_MAX_LENGTH - text.length)}</div>
      ) : null}
    </div>
  );
};

type Props = {
  children: string;
};

const PREVIEW_MAX_LENGTH = 150;

// No-break space, zero-width non-joiner, zero-width space, zero-width joiner,
// left-to-right mark, right-to-left mark, zero-width no-break space.
const PREVIEW_PADDING =
  "\u{A0}\u{200C}\u{200B}\u{200D}\u{200E}\u{200F}\u{FEFF}";

const HIDDEN = {
  display: "none",
  overflow: "hidden",
  lineHeight: "1px",
  opacity: 0,
  maxHeight: 0,
  maxWidth: 0,
} as const satisfies React.CSSProperties;
