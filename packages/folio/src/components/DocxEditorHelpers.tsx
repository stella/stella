/**
 * DocxEditor helper components — loading, placeholder, error states.
 */

import { AlertCircleIcon, FileIcon } from "lucide-react";

import { useTranslations } from "use-intl";

export function DefaultLoadingIndicator() {
  const t = useTranslations("folio");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 text-[var(--doc-text-muted)]">
      <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-[var(--doc-border)] border-t-[var(--doc-primary)]" />
      <span className="text-sm">{t("loadingDocument")}</span>
    </div>
  );
}

export function DefaultPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-[var(--doc-text-subtle)]">
      <FileIcon size={48} strokeWidth={1.5} />
      <span className="mt-4 text-sm">No document loaded</span>
    </div>
  );
}

export function ParseError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-5 text-center">
      <AlertCircleIcon
        size={48}
        strokeWidth={1.5}
        className="text-[var(--doc-error)]"
      />
      <h3 className="mt-4 text-base font-semibold text-[var(--doc-error)]">
        Failed to Load Document
      </h3>
      <p className="mt-2 max-w-[400px] text-sm text-[var(--doc-text-muted)]">
        {message}
      </p>
    </div>
  );
}
