import type React from "react";

type Props = React.PropsWithChildren<{
  style: React.CSSProperties;
}>;

/** The centred content column, as a presentation table capped at 600px. */
export const Container = ({ children, style }: Props) => (
  <table
    align="center"
    width="100%"
    border={0}
    cellPadding="0"
    cellSpacing="0"
    role="presentation"
    style={{ maxWidth: "37.5em", ...style }}
  >
    <tbody>
      <tr style={{ width: "100%" }}>
        <td>{children}</td>
      </tr>
    </tbody>
  </table>
);
