import type { ReactNode } from "react";

/** Unavailable data leaves no section chrome or fallback copy behind. */
export const AvailableCoverageSection = <TData,>({
  data,
  children,
}: {
  data: TData | null;
  children: (data: TData) => ReactNode;
}) => {
  if (data === null) {
    return null;
  }
  return <>{children(data)}</>;
};
