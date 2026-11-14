import type { SVGProps } from "react";

import { STELLA_MARK } from "./stella-mark.shared";

export const StellaMark = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="currentColor"
    viewBox={STELLA_MARK.viewBox}
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    {STELLA_MARK.paths.map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);
