// oxlint-disable-next-line tooltip-provider-owner/tooltip-provider-owner -- regression fixture for a nested provider import
import { TooltipProvider } from "@stll/ui/tooltip";

export const NestedProvider = ({ children }: React.PropsWithChildren) => (
  <TooltipProvider>{children}</TooltipProvider>
);
