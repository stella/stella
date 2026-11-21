import type React from "react";

type Props = React.PropsWithChildren<{
  style: React.CSSProperties;
}>;

/**
 * A paragraph. The margin is also written out as the four longhands, after
 * the style, because some clients honour only the longhands; a side the style
 * leaves unset defaults to 16px top and bottom.
 */
export const Text = ({ children, style }: Props) => (
  <p
    style={{
      fontSize: "14px",
      lineHeight: "24px",
      ...style,
      ...computeMargins(style),
    }}
  >
    {children}
  </p>
);

type MarginSide = "marginTop" | "marginRight" | "marginBottom" | "marginLeft";

type Margin = React.CSSProperties["marginTop"];

// Ordered like an object's keys: setting a side again keeps its place.
type Margins = Map<MarginSide, Margin>;

/**
 * Resolves the four margin longhands in declaration order: the defaults, then
 * each margin property of `style`, a `margin` shorthand replacing all four.
 * The longhands are written in the order they were resolved.
 */
function computeMargins(style: React.CSSProperties): React.CSSProperties {
  const declared: React.CSSProperties = {
    ...(style.marginTop === undefined ? { marginTop: "16px" } : {}),
    ...(style.marginBottom === undefined ? { marginBottom: "16px" } : {}),
    ...style,
  };
  let margins: Margins = new Map<MarginSide, Margin>([
    ["marginTop", undefined],
    ["marginRight", undefined],
    ["marginBottom", undefined],
    ["marginLeft", undefined],
  ]);
  for (const key of Object.keys(declared)) {
    switch (key) {
      case "margin":
        margins = expandMargin(declared.margin);
        break;
      case "marginTop":
        margins.set("marginTop", declared.marginTop);
        break;
      case "marginRight":
        margins.set("marginRight", declared.marginRight);
        break;
      case "marginBottom":
        margins.set("marginBottom", declared.marginBottom);
        break;
      case "marginLeft":
        margins.set("marginLeft", declared.marginLeft);
        break;
      default:
        break;
    }
  }
  const longhands: React.CSSProperties = {};
  for (const [side, value] of margins) {
    if (value !== undefined) {
      longhands[side] = value;
    }
  }
  return longhands;
}

/** Expands a `margin` shorthand of one to four values into its longhands. */
function expandMargin(value: React.CSSProperties["margin"]): Margins {
  if (typeof value === "number") {
    return allSides(value);
  }
  const values = value === undefined ? [] : value.trim().split(/\s+/u);
  const [top, right, bottom, left] = values;
  if (top === undefined || values.length > 4) {
    return allSides(undefined);
  }
  if (right === undefined) {
    return allSides(top);
  }
  return new Map<MarginSide, Margin>([
    ["marginTop", top],
    ["marginRight", right],
    ["marginBottom", bottom ?? top],
    ["marginLeft", left ?? right],
  ]);
}

function allSides(value: Margin): Margins {
  return new Map<MarginSide, Margin>([
    ["marginTop", value],
    ["marginBottom", value],
    ["marginLeft", value],
    ["marginRight", value],
  ]);
}
