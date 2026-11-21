import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { AiActionIcon } from "@stll/ui/icons";

/**
 * The ask before stella AI drafts anything: one line and Allow, with what a
 * draft sends a click away. A time entry card and Settings both ask with it,
 * so the consent reads the same wherever it is given.
 */
export const DraftConsent = ({
  onAllow,
  pending,
}: {
  onAllow: () => void;
  pending: boolean;
}) => {
  const t = useTranslations("activity");
  return (
    <Collapsible
      className="bg-muted/60 flex flex-col gap-2 rounded-lg px-2.5 py-2 text-xs"
      data-activity-draft-consent=""
    >
      <div className="flex items-center gap-2">
        <AiActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 text-pretty">
          {t("aiDraftOffer")}{" "}
          <CollapsibleTrigger render={<Button size="inline" variant="link" />}>
            {t("aiDraftWhatIsSent")}
          </CollapsibleTrigger>
        </p>
        <Button loading={pending} onClick={onAllow} size="xs" variant="outline">
          {t("aiDraftAllow")}
        </Button>
      </div>
      <CollapsiblePanel>
        <p className="text-muted-foreground ps-5.5 text-pretty">
          {t("aiDraftConsent")}
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
};
