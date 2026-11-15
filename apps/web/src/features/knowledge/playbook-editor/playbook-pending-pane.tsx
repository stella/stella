import { useTranslations } from "use-intl";

import { ClipboardCheckIcon } from "@stll/ui/icons";

import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";

type PlaybookPendingPaneProps = {
  label: string;
  onClose: () => void;
};

/** The pane of a chat that is building a playbook it has not saved yet. */
export const PlaybookPendingPane = ({
  label,
  onClose,
}: PlaybookPendingPaneProps) => {
  const t = useTranslations();
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={label} onClose={onClose} />
      <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
        <ClipboardCheckIcon
          aria-hidden="true"
          className="text-muted-foreground size-6"
        />
        <h2 className="text-foreground text-sm font-medium text-balance">
          {t("knowledge.playbooks.pendingPane.title")}
        </h2>
        <p className="text-muted-foreground text-sm text-pretty">
          {t("knowledge.playbooks.pendingPane.description")}
        </p>
      </div>
    </div>
  );
};
