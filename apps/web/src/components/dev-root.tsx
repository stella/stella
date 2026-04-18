import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useShallow } from "zustand/react/shallow";

import { useDevStore } from "@/lib/dev-store";

export default function DevRoot() {
  const [tanstackDevtools, sourceInspector] = useDevStore(
    useShallow((s) => [s.tanstackDevtools, s.sourceInspector]),
  );

  return tanstackDevtools ? (
    <TanStackDevtools
      config={{
        inspectHotkey: sourceInspector ? ["Shift", "CtrlOrMeta"] : [],
      }}
      plugins={[
        {
          name: "React Query",
          render: <ReactQueryDevtoolsPanel />,
        },
        {
          name: "TanStack Router",
          render: <TanStackRouterDevtoolsPanel />,
        },
      ]}
    />
  ) : null;
}
