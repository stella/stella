import { createContext, use, useState } from "react";

import { requireNativeView, requireOptionalNativeModule } from "expo";
import { StyleSheet } from "react-native";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

import type { LayoutMetrics } from "@/state/layout";

type ObserverProps = ViewProps & {
  readonly onMetricsChange: (
    event: NativeSyntheticEvent<LayoutMetrics>,
  ) => void;
};

// Absent on Android, the web and a client built before the observer.
const LayoutObserver =
  requireOptionalNativeModule("LayoutMetrics") === null
    ? null
    : requireNativeView<ObserverProps>("LayoutMetrics");

const LayoutMetricsContext = createContext<LayoutMetrics | null>(null);

/**
 * What the platform says about the window beyond its size, for the app's
 * columns: the size class, and on a foldable iPhone where its fold lies.
 * Null until the first report, and wherever the observer is missing.
 */
export const LayoutMetricsProvider = ({
  children,
}: React.PropsWithChildren) => {
  const [metrics, setMetrics] = useState<LayoutMetrics | null>(null);

  return (
    <LayoutMetricsContext value={metrics}>
      {LayoutObserver === null ? null : (
        <LayoutObserver
          onMetricsChange={(event) => {
            setMetrics(event.nativeEvent);
          }}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      )}
      {children}
    </LayoutMetricsContext>
  );
};

export const useLayoutMetrics = (): LayoutMetrics | null =>
  use(LayoutMetricsContext);
