import { MessageResponseImpl } from "@/components/ai-elements/message-response";
import { markdownPreviewProps } from "@/components/markdown-preview";

/**
 * A markdown preview for a chunk that is already lazy. It imports the renderer
 * statically, so it never paints raw source and swaps it for rendered text.
 * Importing this outside a lazy chunk pulls the renderer into that bundle.
 */
export const LoadedMarkdownPreview = ({ children }: { children: string }) => (
  <MessageResponseImpl {...markdownPreviewProps({})}>
    {children}
  </MessageResponseImpl>
);
