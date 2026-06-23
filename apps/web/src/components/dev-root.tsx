import { lazy, Suspense } from "react";

import { useShallow } from "zustand/react/shallow";

import { useDevStore } from "@/lib/dev-store";

const TanStackDevtoolsRoot = lazy(
  async () => await import("@/components/tanstack-devtools-root"),
);

export default function DevRoot() {
  const [tanstackDevtools, sourceInspector] = useDevStore(
    useShallow((s) => [s.tanstackDevtools, s.sourceInspector]),
  );

  return tanstackDevtools ? (
    <Suspense fallback={null}>
      <TanStackDevtoolsRoot sourceInspector={sourceInspector} />
    </Suspense>
  ) : null;
}
