import { PaperclipIcon } from "@stll/ui/icons";

import type { Translate } from "@/components/panel";
import type { MailSnapshot } from "@/types";

/**
 * Which email the pane is working on, in two quiet lines. The email itself
 * is open next to the pane, so this only has to identify it.
 */
export const MailContext = ({
  snapshot,
  t,
}: {
  snapshot: MailSnapshot;
  t: Translate;
}) => (
  <div className="flex min-w-0 flex-col gap-0.5 px-1">
    <p className="truncate text-sm font-medium">
      <bdi>{snapshot.subject || t("subjectFallback")}</bdi>
    </p>
    <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <span className="truncate">
        <bdi>{senderName(snapshot)}</bdi>
      </span>
      {snapshot.attachments.length > 0 ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <PaperclipIcon aria-hidden="true" className="size-3" />
          {t("attachmentCount", { count: snapshot.attachments.length })}
        </span>
      ) : null}
    </p>
  </div>
);

const senderName = (snapshot: MailSnapshot): string => {
  if (snapshot.mode === "compose") {
    const first = snapshot.to.at(0);
    return first ? first.name || first.email : "";
  }
  return snapshot.from ? snapshot.from.name || snapshot.from.email : "";
};
