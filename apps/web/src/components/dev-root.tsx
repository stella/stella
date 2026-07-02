import { lazy, Suspense } from "react";

import { useShallow } from "zustand/react/shallow";

import { useMountEffect } from "@/hooks/use-effect";
import { installDevPerfBudget } from "@/lib/dev-perf-budget";
import { useDevStore } from "@/lib/dev-store";

const TanStackDevtoolsRoot = lazy(
  async () => await import("@/components/tanstack-devtools-root"),
);

export default function DevRoot() {
  useMountEffect(() => installDevPerfBudget());
  const [tanstackDevtools, sourceInspector] = useDevStore(
    useShallow((s) => [s.tanstackDevtools, s.sourceInspector]),
  );

  return tanstackDevtools ? (
    <Suspense fallback={null}>
      <TanStackDevtoolsRoot sourceInspector={sourceInspector} />
    </Suspense>
  ) : null;
}
