import { useTranslations } from "use-intl";

import { LoadedMarkdownPreview } from "@/components/markdown-preview-loaded";
import { CopyButton } from "@/features/knowledge/public/tools/copy-button";

// Client-only: the markdown renderer (streamdown) and clipboard copy are
// browser concerns. Lazy-loaded by the detail page so SSR stays light;
// the raw markdown arrives from the route loader (in-tree bundle or a
// server-fetched pinned SHA). The renderer loads with this chunk, because
// painting the raw text first moves every line when the rendered text lands.
export const ToolMarkdown = ({ markdown }: { markdown: string }) => {
  const t = useTranslations();

  return (
    <section
      aria-label={t("publicTools.content")}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("publicTools.content")}</h2>
        <CopyButton text={markdown} />
      </div>
      <div className="border-border bg-card rounded-md border p-4">
        <LoadedMarkdownPreview>{markdown}</LoadedMarkdownPreview>
      </div>
    </section>
  );
};
