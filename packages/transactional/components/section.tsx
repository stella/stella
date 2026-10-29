import type React from "react";

type Props = React.PropsWithChildren<{
  style: React.CSSProperties;
}>;

/** A full-width block, as a single-cell presentation table. */
export const Section = ({ children, style }: Props) => (
  <table
    align="center"
    width="100%"
    border={0}
    cellPadding="0"
    cellSpacing="0"
    role="presentation"
    style={style}
  >
    <tbody>
      <tr>
        <td>{children}</td>
      </tr>
    </tbody>
  </table>
);
