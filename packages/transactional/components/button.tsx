import type React from "react";

type Props = React.PropsWithChildren<{
  href: string;
  style: React.CSSProperties;
}>;

/**
 * A link styled as a button. Outlook on Windows ignores padding on links, so
 * the horizontal padding is rebuilt there from hair spaces at a stretched font
 * width inside conditional comments, and the text is raised by the vertical
 * padding; every other client uses the padding longhands.
 */
export const Button = ({ children, href, style }: Props) => {
  const { paddingTop, paddingRight, paddingBottom, paddingLeft } =
    parsePadding(style);
  const textRaise = pxToPt((paddingTop ?? 0) + (paddingBottom ?? 0));
  const [leftFontWidth, leftSpaceCount] = computeFontWidthAndSpaceCount(
    paddingLeft ?? 0,
  );
  const [rightFontWidth, rightSpaceCount] = computeFontWidthAndSpaceCount(
    paddingRight ?? 0,
  );
  const linkStyle: MsoStyle = {
    lineHeight: "100%",
    textDecoration: "none",
    display: "inline-block",
    maxWidth: "100%",
    msoPaddingAlt: "0px",
    ...style,
    ...(paddingTop === undefined ? {} : { paddingTop }),
    ...(paddingRight === undefined ? {} : { paddingRight }),
    ...(paddingBottom === undefined ? {} : { paddingBottom }),
    ...(paddingLeft === undefined ? {} : { paddingLeft }),
  };
  const labelStyle: MsoStyle = {
    maxWidth: "100%",
    display: "inline-block",
    lineHeight: "120%",
    msoPaddingAlt: "0px",
    msoTextRaise: pxToPt(paddingBottom),
  };
  return (
    // oxlint-disable-next-line react/jsx-no-target-blank -- an email has no opener window to protect, and the markup stays the one mail clients are tested against.
    <a href={href} style={linkStyle} target="_blank">
      <span
        dangerouslySetInnerHTML={{
          // safe-html: numbers computed from the style above and a fixed entity, no caller text
          __html: `<!--[if mso]><i style="mso-font-width:${leftFontWidth * 100}%;mso-text-raise:${String(textRaise)}" hidden>${HAIR_SPACE.repeat(leftSpaceCount)}</i><![endif]-->`,
        }}
      />
      <span style={labelStyle}>{children}</span>
      <span
        dangerouslySetInnerHTML={{
          // safe-html: numbers computed from the style above and fixed entities, no caller text
          __html: `<!--[if mso]><i style="mso-font-width:${rightFontWidth * 100}%" hidden>${HAIR_SPACE.repeat(rightSpaceCount)}&#8203;</i><![endif]-->`,
        }}
      />
    </a>
  );
};

/** Outlook-only properties; React writes them hyphenated like any other. */
type MsoStyle = React.CSSProperties & {
  msoPaddingAlt?: string;
  msoTextRaise?: number | undefined;
};

type Padding = {
  paddingTop: number | undefined;
  paddingRight: number | undefined;
  paddingBottom: number | undefined;
  paddingLeft: number | undefined;
};

type PaddingValue = React.CSSProperties["paddingTop"];

const HAIR_SPACE = "&#8202;";

// Outlook stretches a character to at most 500% of its width.
const MAX_FONT_WIDTH = 5;

/**
 * The padding longhands in px, in declaration order: a `padding` shorthand
 * sets all four, a longhand after it overrides its side.
 */
function parsePadding(style: React.CSSProperties): Padding {
  let top: PaddingValue;
  let right: PaddingValue;
  let bottom: PaddingValue;
  let left: PaddingValue;
  for (const key of Object.keys(style)) {
    switch (key) {
      case "padding":
        [top, right, bottom, left] = expandPadding(style.padding);
        break;
      case "paddingTop":
        top = style.paddingTop;
        break;
      case "paddingRight":
        right = style.paddingRight;
        break;
      case "paddingBottom":
        bottom = style.paddingBottom;
        break;
      case "paddingLeft":
        left = style.paddingLeft;
        break;
      default:
        break;
    }
  }
  return {
    paddingTop: convertToPx(top),
    paddingRight: convertToPx(right),
    paddingBottom: convertToPx(bottom),
    paddingLeft: convertToPx(left),
  };
}

/** Expands a `padding` shorthand into top, right, bottom and left. */
function expandPadding(
  value: React.CSSProperties["padding"],
): [PaddingValue, PaddingValue, PaddingValue, PaddingValue] {
  if (typeof value === "number") {
    return [value, value, value, value];
  }
  const values = value === undefined ? [] : value.trim().split(/\s+/u);
  const [top, right, bottom, left] = values;
  if (top === undefined || values.length > 4) {
    return [undefined, undefined, undefined, undefined];
  }
  return [top, right ?? top, bottom ?? top, left ?? right ?? top];
}

/**
 * A length in px; em and rem at 16px, % of a 600px wide email. An unset or
 * empty side, or zero, stays unset; any other unitless value is 0.
 */
function convertToPx(value: PaddingValue): number | undefined {
  if (typeof value === "number") {
    return value === 0 || Number.isNaN(value) ? undefined : value;
  }
  if (value === undefined || value === "") {
    return undefined;
  }
  const match = /^([\d.]+)(px|em|rem|%)$/u.exec(value);
  if (match === null) {
    return 0;
  }
  const [, amount = "", unit = "px"] = match;
  const number = Number.parseFloat(amount);
  switch (unit) {
    case "em":
    case "rem":
      return number * 16;
    case "%":
      return (number / 100) * 600;
    default:
      return number;
  }
}

function pxToPt(px: number | undefined): number | undefined {
  return px === undefined || Number.isNaN(px) ? undefined : (px * 3) / 4;
}

/**
 * The font width (at most `MAX_FONT_WIDTH`) and the number of hair spaces
 * whose stretched width is closest to `expectedWidth`.
 */
function computeFontWidthAndSpaceCount(
  expectedWidth: number,
): [fontWidth: number, spaceCount: number] {
  if (expectedWidth === 0) {
    return [0, 0];
  }
  let spaceCount = 1;
  while (expectedWidth / spaceCount / 2 > MAX_FONT_WIDTH) {
    spaceCount += 1;
  }
  return [expectedWidth / spaceCount / 2, spaceCount];
}
