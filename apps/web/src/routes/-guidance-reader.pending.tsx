import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

/**
 * The guidance reader's frame: the notice that this is not a court decision
 * over the document's header, its text and its source footer. The page puts
 * the document in the slots; the pending view puts placeholders of the same
 * shape there until it is.
 */
export const GuidanceReaderShell = ({
  header,
  body,
  footer,
}: {
  header: ReactNode;
  body: ReactNode;
  footer: ReactNode;
}) => {
  const t = useTranslations();
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
      <p className="text-muted-foreground text-sm">
        {t("guidance.notCaseLaw")}
      </p>
      <header className="flex flex-col gap-1">{header}</header>
      {body}
      <footer className="text-muted-foreground flex flex-col gap-1 border-t pt-4 text-xs">
        {footer}
      </footer>
    </article>
  );
};

const PENDING_PARAGRAPH_ROWS = 3;

export const GuidanceReaderPending = () => (
  <GuidanceReaderShell
    header={
      <>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-32" />
      </>
    }
    body={
      <div className="flex flex-col gap-3">
        {Array.from(
          { length: PENDING_PARAGRAPH_ROWS },
          (_, row) => `paragraph-${row}`,
        ).map((rowKey) => (
          <Skeleton className="h-16 w-full" key={rowKey} />
        ))}
      </div>
    }
    footer={<Skeleton className="h-3 w-56" />}
  />
);
