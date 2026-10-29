import { ScrollArea } from "@stll/ui/scroll-area";

import { useScreenModel } from "@/lib/capabilities/screen-model";

/** Development panel: the live screen model of the current route. */
const ScreenModelPanel = () => {
  const model = useScreenModel();
  return (
    <ScrollArea className="h-full">
      <pre className="p-3 font-mono text-xs">
        {JSON.stringify(model, null, 2)}
      </pre>
    </ScrollArea>
  );
};

export default ScreenModelPanel;
