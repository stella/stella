import { Button } from "@stll/ui/button";
import { SquareIcon, XIcon } from "@stll/ui/icons";

import { manualRedactionCatalog } from "@/components/pdf/manual-redaction/manual-redaction-catalog";
import { useManualRedactionStore } from "@/components/pdf/manual-redaction/manual-redaction-store";

type ManualRedactionSectionProps = {
  fieldId: string;
};

/**
 * Turns marking on and off for the reader's pages and lists the marked areas.
 * Renders once the reader shows this file's own PDF pages.
 */
export const ManualRedactionSection = (props: ManualRedactionSectionProps) => (
  <manualRedactionCatalog.Provider fallback={null}>
    <Section {...props} />
  </manualRedactionCatalog.Provider>
);

const Section = ({ fieldId }: ManualRedactionSectionProps) => {
  const t = manualRedactionCatalog.useTranslations();
  const field = useManualRedactionStore((s) => s.byFieldId[fieldId]);
  const setMode = useManualRedactionStore((s) => s.setMode);
  const dispatch = useManualRedactionStore((s) => s.dispatch);
  if (field === undefined) {
    return null;
  }
  const marking = field.mode === "drawing";

  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-foreground text-xs font-medium">
        {t("manualRedaction.title")}
      </h4>
      <Button
        aria-pressed={marking}
        className="w-full justify-start"
        onClick={() => setMode(fieldId, marking ? "viewing" : "drawing")}
        size="sm"
        variant={marking ? "default" : "outline"}
      >
        <SquareIcon />
        {marking
          ? t("manualRedaction.stopMarking")
          : t("manualRedaction.startMarking")}
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {t("manualRedaction.hint")}
      </p>
      {field.areas.length > 0 && (
        <ul className="flex flex-col">
          {field.areas.map((area) => (
            <li
              className="flex items-center justify-between gap-2 text-xs"
              key={area.id}
            >
              {t("manualRedaction.pageArea", { page: area.pageIndex + 1 })}
              <Button
                aria-label={t("manualRedaction.removeArea", {
                  page: area.pageIndex + 1,
                })}
                onClick={() =>
                  dispatch({
                    fieldId,
                    documentKey: field.documentKey,
                    action: { type: "remove", id: area.id },
                  })
                }
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
