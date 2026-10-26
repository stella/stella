import { useTranslations } from "use-intl";

import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import type { OrphanedReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotation-placement.logic";

/**
 * The marks the document's current text has no place for: its text was
 * updated since they were made, and their words are gone or repeated with
 * nothing to tell the places apart. They are listed with their words rather
 * than drawn anywhere, so a mark never sits on text it was not made on, and
 * the reader can remove their own. Renders nothing while every mark is
 * placed.
 */
export const OrphanedAnnotationsNotice = ({
  className,
  onRemove,
  orphaned,
}: {
  className?: string | undefined;
  onRemove: (id: string) => void;
  orphaned: readonly OrphanedReaderAnnotation[];
}) => {
  const t = useTranslations();

  if (orphaned.length === 0) {
    return null;
  }

  return (
    <details
      className={cn(
        "bg-muted text-muted-foreground border-b px-4 py-2 text-xs",
        className,
      )}
    >
      <summary className="cursor-pointer py-1">
        {t("legalReader.annotations.orphaned.summary", {
          count: orphaned.length,
        })}
      </summary>
      <p className="py-1">
        {t("legalReader.annotations.orphaned.description")}
      </p>
      <ul className="space-y-2 py-1">
        {orphaned.map(({ annotation }) => (
          <li className="flex items-start gap-3" key={annotation.id}>
            <div className="min-w-0 flex-1 space-y-1">
              <blockquote
                className="text-foreground border-s-2 ps-2 wrap-break-word"
                dir="auto"
              >
                {annotation.quote}
              </blockquote>
              {annotation.body !== null && (
                <UserText as="p" className="wrap-break-word">
                  {annotation.body}
                </UserText>
              )}
              {!annotation.mine && (
                <UserText as="p">{annotation.authorName}</UserText>
              )}
            </div>
            {annotation.mine && (
              <Button
                className="shrink-0"
                onClick={() => onRemove(annotation.id)}
                size="sm"
                variant="outline"
              >
                {t("common.remove")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
};
