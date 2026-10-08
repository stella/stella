import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

export const ProposedBlockAction = ({
  drafted,
  enabled,
  onCreate,
}: {
  drafted: boolean;
  enabled: boolean;
  onCreate: () => void;
}) => {
  const t = useTranslations("activity");
  if (drafted) {
    return (
      <span className="text-muted-foreground text-xs" role="status">
        {t("draftedEntry")}
      </span>
    );
  }
  if (!enabled) {
    return null;
  }
  return (
    <Button onClick={onCreate} size="sm" variant="outline">
      {t("createDraftEntry")}
    </Button>
  );
};
