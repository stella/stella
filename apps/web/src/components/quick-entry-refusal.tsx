import { useTranslations } from "use-intl";

import { quickEntryRefusalKey } from "@/components/quick-entry.logic";

export const QuickEntryRefusal = ({ error }: { error: unknown }) => {
  const t = useTranslations();
  return (
    <p className="text-destructive text-sm" role="alert">
      {t(quickEntryRefusalKey(error))}
    </p>
  );
};
