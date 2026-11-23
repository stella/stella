import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import { AiActionIcon } from "@stll/ui/icons";

import { useAiDraftInputs } from "./ActivityDisclosure";
import type { DraftConsentStatus } from "./billing-draft-transport";

/**
 * The ask before stella AI drafts anything: one line and Allow, with what a
 * draft sends a click away. A time entry card and Settings both ask with it,
 * so the consent reads the same wherever it is given. A grant on its way
 * keeps Allow busy; one the server did not confirm says so, and Allow tries
 * again.
 */
export const DraftConsent = ({
  onAllow,
  status,
}: {
  onAllow: () => void;
  status: DraftConsentStatus;
}) => {
  const t = useTranslations("activity");
  const consentText = useDraftConsentText();
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
        <Button
          loading={status === "pending-grant"}
          onClick={onAllow}
          size="xs"
          variant="outline"
        >
          {t("aiDraftAllow")}
        </Button>
      </div>
      {status === "grant-refused" ? <DraftConsentRefused /> : null}
      <CollapsiblePanel>
        <p className="text-muted-foreground ps-5.5 text-pretty">
          {consentText}
        </p>
      </CollapsiblePanel>
    </Collapsible>
  );
};

/** What a draft is written from and where it goes, in the disclosure's own
 *  list: every place that asks for consent states it with this. */
export const useDraftConsentText = () => {
  const t = useTranslations("activity");
  return t("aiDraftConsent", useAiDraftInputs());
};

/** A grant the server did not confirm: consent is not given, and the same
 *  choice can be made again. */
export const DraftConsentRefused = () => {
  const t = useTranslations("activity");
  return (
    <p className="text-destructive-foreground text-pretty" role="alert">
      {t("errorUpdate")}
    </p>
  );
};
