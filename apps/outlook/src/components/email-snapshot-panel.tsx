import { MailPlusIcon } from "lucide-react";

import { Panel } from "@/components/panel";
import type { Translate } from "@/components/panel";
import type { MailSnapshot } from "@/types";

export const EmailSnapshotPanel = ({
  snapshot,
  t,
}: {
  snapshot: MailSnapshot;
  t: Translate;
}) => (
  <Panel>
    <div className="flex min-w-0 items-start gap-2.5">
      <MailPlusIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <h2 className="truncate text-sm/5 font-medium">
          {snapshot.subject || t("subjectFallback")}
        </h2>
        <p className="text-muted-foreground text-xs/4.5">
          {senderLine(snapshot)}
        </p>
      </div>
    </div>
    <div className="bg-muted/40 border-border max-h-28 overflow-auto rounded-lg border">
      <p className="px-3 py-2.5 text-xs/5 whitespace-pre-wrap">
        {snapshot.bodyText || t("noBody")}
      </p>
    </div>
  </Panel>
);

const senderLine = (snapshot: MailSnapshot): string => {
  const date = formatDate(snapshot.sentAt);
  if (!snapshot.from) {
    return date;
  }
  const name = snapshot.from.name || snapshot.from.email;
  return date ? `${name} · ${date}` : name;
};

const formatDate = (value: string | null): string => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};
