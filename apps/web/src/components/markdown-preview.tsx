import { cn } from "@stll/ui/lib/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import type { MessageResponseProps } from "@/components/ai-elements/message-response";

const MARKDOWN_PREVIEW_COMPONENTS: MessageResponseProps["components"] = {};

type MarkdownPreviewProps = Omit<MessageResponseProps, "components"> & {
  components?: MessageResponseProps["components"];
};

export const MarkdownPreview = ({
  className,
  components = MARKDOWN_PREVIEW_COMPONENTS,
  ...props
}: MarkdownPreviewProps) => (
  <MessageResponse
    className={cn(
      "text-sm leading-relaxed",
      "[&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold",
      "[&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
      "[&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
      "[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto",
      "[&_pre]:bg-muted/40 [&_pre]:rounded-md [&_pre]:border",
      "[&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed",
      "[&_code]:font-mono",
      "[&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:rounded",
      "[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5",
      className,
    )}
    components={components}
    {...props}
  />
);
