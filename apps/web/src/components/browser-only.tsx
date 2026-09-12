import { Suspense, use } from "react";
import type { ReactElement, ReactNode } from "react";
import { browser } from "react-dom";

type BrowserOnlyProps = {
  children: ReactElement;
  fallback?: ReactNode;
};

/** Streams a fallback during SSR, then reveals children in the browser. */
export const BrowserOnly = ({
  children,
  fallback = null,
}: BrowserOnlyProps) => (
  <Suspense fallback={fallback}>
    <BrowserContent>{children}</BrowserContent>
  </Suspense>
);

/** Suspends before browser-dependent children are evaluated. */
const BrowserContent = ({ children }: Pick<BrowserOnlyProps, "children">) => {
  use(browser());
  return children;
};
