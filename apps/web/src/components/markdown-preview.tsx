import type { ComponentProps } from "react";

import { cn } from "@stll/ui/lib/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { isSafeMarkdownPreviewImageSrc } from "@/components/markdown-preview.logic";

// Markdown previews render untrusted document content. A remote image
// source would be fetched the moment the inspector opens, leaking
// document-open activity to an attacker-controlled URL (tracking pixel /
// SSRF). Only render images whose data is embedded in the document; for
// anything else, fall back to the alt text so nothing hits the network.
const SafePreviewImage = ({
  alt,
  node: _node,
  src,
  ...props
}: ComponentProps<"img"> & { node?: unknown }) => {
  if (isSafeMarkdownPreviewImageSrc(src)) {
    return <img alt={alt} src={src} {...props} />;
  }
  return alt ? (
    <span className="text-muted-foreground italic">{alt}</span>
  ) : null;
};

const MARKDOWN_PREVIEW_COMPONENTS = {
  img: SafePreviewImage,
} satisfies MessageResponseProps["components"];

type MarkdownPreviewProps = Omit<MessageResponseProps, "components"> & {
  components?: MessageResponseProps["components"];
};

export const MarkdownPreview = ({
  className,
  components,
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
    components={
      components
        ? { ...components, ...MARKDOWN_PREVIEW_COMPONENTS }
        : MARKDOWN_PREVIEW_COMPONENTS
    }
    {...props}
  />
);
