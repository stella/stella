import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { tableDevtoolsPlugin } from "@tanstack/react-table-devtools";

export default function TanStackDevtoolsRoot({
  sourceInspector,
}: {
  sourceInspector: boolean;
}) {
  return (
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
        tableDevtoolsPlugin(),
      ]}
    />
  );
}
