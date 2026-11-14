import type { ReactNode } from "react";

// Passive regression fixture for no-hand-built-step-marker.
const Steps = ({ children }: { children: ReactNode }) => <ol>{children}</ol>;
const Step = ({ children }: { children: ReactNode }) => <li>{children}</li>;

export const BadNumberedMarker = () => (
  // oxlint-disable-next-line no-hand-built-step-marker/no-hand-built-step-marker -- fixture proves padded markers are rejected outside Steps
  <span>{String(index + 1).padStart(2, "0")}</span>
);

export const OrderedSteps = () => (
  // expect-clean: no-hand-built-step-marker/no-hand-built-step-marker
  <Steps>
    <Step>Prepare</Step>
    <Step>Review</Step>
  </Steps>
);
