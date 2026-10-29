import type React from "react";

type Props = React.PropsWithChildren<{
  style: React.CSSProperties;
}>;

/** The email's title. */
export const Heading = ({ children, style }: Props) => (
  <h1 style={style}>{children}</h1>
);
