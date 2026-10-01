import { cn } from "@stll/ui/utils";

import { CopyActionButton } from "@/components/copy-action-button";

// Client-only: reads `navigator.clipboard`. Lazy-loaded by the detail
// page so it never runs during SSR.
export const CopyButton = ({
  text,
  className,
}: {
  text: string;
  className?: string;
}) => (
  <CopyActionButton
    className={cn(className)}
    size="xs"
    text={text}
    variant="outline"
  />
);
