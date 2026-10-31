import type React from "react";

type Props = {
  style: React.CSSProperties;
};

/** A divider drawn as a top border, so clients render it the same way. */
export const Hr = ({ style }: Props) => (
  <hr
    style={{
      width: "100%",
      border: "none",
      borderTop: "1px solid #eaeaea",
      ...style,
    }}
  />
);
