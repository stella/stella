import type React from "react";

type Props = {
  alt: string;
  src: string;
  width: string;
  height: string;
  style: React.CSSProperties;
};

/** A block image without the border or outline some clients add to it. */
export const Img = ({ alt, src, width, height, style }: Props) => (
  <img
    alt={alt}
    height={height}
    src={src}
    style={{
      display: "block",
      outline: "none",
      border: "none",
      textDecoration: "none",
      ...style,
    }}
    width={width}
  />
);
