import { useTranslations } from "use-intl";

// "Today" is a position on the timeline, not a failure: it reads in the
// foreground tone so it stands out from the muted date labels without
// borrowing the destructive color.
export const HorizontalTodayMarker = () => {
  const t = useTranslations();
  return (
    <div className="w-20 shrink-0 snap-end">
      <div className="h-5" />
      <div className="text-foreground text-2xs mt-1 h-4 text-end font-medium">
        {t("common.today")}
      </div>
      <div aria-hidden="true" className="relative mt-2 h-3">
        <span className="bg-border absolute start-0 end-0 top-1/2 h-px" />
        <span className="bg-foreground absolute end-0 top-0 h-3 w-px" />
      </div>
    </div>
  );
};
