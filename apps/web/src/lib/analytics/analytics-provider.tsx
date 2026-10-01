import { useState } from "react";
import type { PropsWithChildren } from "react";

import {
  AnalyticsContext,
  type AnalyticsValue,
} from "@/lib/analytics/provider";

type AnalyticsProviderProps = PropsWithChildren<{
  value: AnalyticsValue;
}>;

export const AnalyticsProvider = ({
  children,
  value: providedValue,
}: AnalyticsProviderProps) => {
  const [value] = useState(() => providedValue);

  return (
    <AnalyticsContext value={value.analytics}>{children}</AnalyticsContext>
  );
};
