import type React from "react";

type Props = React.PropsWithChildren<{
  style: React.CSSProperties;
}>;

/**
 * The `<body>` keeps only the background; the full style, spacing included,
 * moves to a full-width presentation table cell, because several clients drop
 * or override spacing set on `<body>`. Spacing the style sets is zeroed on
 * `<body>` so the client's default does not add to it.
 */
export const Body = ({ children, style }: Props) => (
  <body style={bodyStyle(style)}>
    <table
      border={0}
      width="100%"
      cellPadding="0"
      cellSpacing="0"
      role="presentation"
      align="center"
    >
      <tbody>
        <tr>
          <td style={style}>{children}</td>
        </tr>
      </tbody>
    </table>
  </body>
);

const SPACING_PROPERTIES = [
  "margin",
  "marginTop",
  "marginBottom",
  "marginRight",
  "marginLeft",
  "marginInline",
  "marginBlock",
  "marginBlockStart",
  "marginBlockEnd",
  "marginInlineStart",
  "marginInlineEnd",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingRight",
  "paddingLeft",
  "paddingInline",
  "paddingBlock",
  "paddingBlockStart",
  "paddingBlockEnd",
  "paddingInlineStart",
  "paddingInlineEnd",
] as const satisfies readonly (keyof React.CSSProperties)[];

function bodyStyle(style: React.CSSProperties): React.CSSProperties {
  const result: React.CSSProperties = {};
  if (style.background !== undefined) {
    result.background = style.background;
  }
  if (style.backgroundColor !== undefined) {
    result.backgroundColor = style.backgroundColor;
  }
  for (const property of SPACING_PROPERTIES) {
    if (style[property] !== undefined) {
      result[property] = 0;
    }
  }
  return result;
}
