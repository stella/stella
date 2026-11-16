import type { SVGProps } from "react";

import { STELLA_WORDMARK } from "./stella-wordmark.shared";

export const StellaWordmarkLatin = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="currentColor"
    viewBox={STELLA_WORDMARK.viewBox}
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    {STELLA_WORDMARK.paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);
