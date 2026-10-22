import { cn } from "@stll/ui/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import type {
  MessageImagePolicy,
  MessageResponseProps,
} from "@/components/ai-elements/message-response";

type MarkdownPreviewProps = Omit<
  MessageResponseProps,
  "children" | "imagePolicy"
> & {
  children: string;
  fallbackChildren?: string | undefined;
};

// Markdown previews render untrusted document content, so opening one must
// not itself trigger a network request driven by that content. Images whose
// data is embedded in the document render; any other image shows its alt text.
const PREVIEW_IMAGES = {
  kind: "embedded-data",
} as const satisfies MessageImagePolicy;

export const MarkdownPreview = ({
  className,
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
    {...props}
    imagePolicy={PREVIEW_IMAGES}
  />
);
