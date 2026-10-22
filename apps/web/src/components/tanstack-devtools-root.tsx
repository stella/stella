import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { tableDevtoolsPlugin } from "@tanstack/react-table-devtools";

import ScreenModelPanel from "@/components/dev/screen-model-panel";

const TanStackDevtoolsRoot = ({
  sourceInspector,
}: {
  sourceInspector: boolean;
}) => (
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
      {
        name: "Screen model",
        render: <ScreenModelPanel />,
      },
    ]}
  />
);

export default TanStackDevtoolsRoot;
