// Passive regression fixture for
// `no-decorative-heading-accent/no-decorative-heading-accent`.

import type { ReactNode } from "react";

const CardHeading = ({ children }: { children: ReactNode }) => (
  <h3>{children}</h3>
);

export const _classAccent = () => (
  <h1>
    One
    {/* oxlint-disable-next-line no-decorative-heading-accent/no-decorative-heading-accent */}
    <span className="italic">word</span>
  </h1>
);
export const _styleAccent = () => (
  <CardHeading>
    Plain
    {/* oxlint-disable-next-line no-decorative-heading-accent/no-decorative-heading-accent */}
    <em style={{ color: "red" }}> emphasis</em>
  </CardHeading>
);
export const _nestedAccent = () => (
  <h4>
    <span>
      {/* oxlint-disable-next-line no-decorative-heading-accent/no-decorative-heading-accent */}
      <strong className="font-bold">Nested</strong>
    </span>
  </h4>
);

// Links carry interaction; the documented meaning attributes communicate a
// language or accessible-name distinction rather than mere decoration.
// expect-clean: no-decorative-heading-accent/no-decorative-heading-accent
export const _linked = () => (
  <h2>
    Read{" "}
    <a href="/details">
      <span className="underline">details</span>
    </a>
  </h2>
);
export const _language = () => (
  <h2>
    Meaning of{" "}
    <i className="italic" lang="la">
      bona fide
    </i>
  </h2>
);
export const _accessibleMeaning = () => (
  <h2>
    Status{" "}
    <mark className="bg-yellow" aria-label="new">
      N
    </mark>
  </h2>
);
export const _unstyled = () => (
  <h2>
    Read <strong>carefully</strong>
  </h2>
);
export const _outsideHeading = () => (
  <p>
    <span className="italic">Fine</span>
  </p>
);
