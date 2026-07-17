import { useTranslations } from "use-intl";

import { MarkdownPreview } from "@/components/markdown-preview";
import { CopyButton } from "@/routes/tools/-components/copy-button";

// Client-only: the markdown renderer (streamdown) and clipboard copy are
// browser concerns. Lazy-loaded by the detail page so SSR stays light;
// the raw markdown arrives from the route loader (in-tree bundle or a
// server-fetched pinned SHA).
export function ToolMarkdown({ markdown }: { markdown: string }) {
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
        <MarkdownPreview>{markdown}</MarkdownPreview>
      </div>
    </section>
  );
}
