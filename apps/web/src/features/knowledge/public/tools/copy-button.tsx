import { cn } from "@stll/ui/utils";

import { CopyControl } from "@/components/copy-control";

// Client-only: it writes the clipboard. Lazy-loaded by the detail
// page so it never runs during SSR.
export const CopyButton = ({
  text,
  className,
}: {
  text: string;
  className?: string;
}) => (
  <CopyControl
    className={cn(className)}
    size="xs"
    text={text}
    variant="outline"
  />
);
