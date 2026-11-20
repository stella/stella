import { useTranslations } from "use-intl";

import { MarkdownPreview } from "@/components/markdown-preview";
import { CopyButton } from "@/features/knowledge/public/tools/copy-button";
import { MarkdownSectionFrame } from "@/features/knowledge/public/tools/markdown-page.pending";

// Client-only: the markdown renderer (streamdown) and clipboard copy are
// browser concerns. Lazy-loaded by the detail page so SSR stays light;
// the raw markdown arrives from the route loader (in-tree bundle or a
// server-fetched pinned SHA).
export const ToolMarkdown = ({ markdown }: { markdown: string }) => {
  const t = useTranslations();

  return (
    <MarkdownSectionFrame
      action={<CopyButton text={markdown} />}
      heading={t("publicTools.content")}
      label={t("publicTools.content")}
    >
      <MarkdownPreview>{markdown}</MarkdownPreview>
    </MarkdownSectionFrame>
  );
};
