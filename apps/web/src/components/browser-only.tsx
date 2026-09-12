import { Suspense, use } from "react";
import type { ReactElement, ReactNode } from "react";
import { browser } from "react-dom";

type BrowserOnlyProps = {
  children: ReactElement;
  fallback?: ReactNode;
};

export const BrowserOnly = ({
  children,
  fallback = null,
}: BrowserOnlyProps) => (
  <Suspense fallback={fallback}>
    <BrowserContent>{children}</BrowserContent>
  </Suspense>
);

const BrowserContent = ({ children }: Pick<BrowserOnlyProps, "children">) => {
  use(browser());
  return children;
};
