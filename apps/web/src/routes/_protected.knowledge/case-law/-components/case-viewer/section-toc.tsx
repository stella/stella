import { useTranslations } from "use-intl";

type TocEntry = {
  anchorId: string;
  label: string;
  level: number;
};

type SectionTocProps = {
  entries: TocEntry[];
};

export const SectionToc = ({ entries }: SectionTocProps) => {
  const t = useTranslations();

  const scrollTo = (anchorId: string) => {
    const element = document.querySelector(`#${anchorId}`);
    element?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  if (entries.length === 0) {
    return null;
  }

  return (
    <nav>
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase">
        {t("caseLaw.viewer.sections")}
      </h3>
      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <li key={entry.anchorId}>
            <button
              className="hover:bg-muted w-full rounded px-2 py-1 text-start text-sm"
              onClick={() => scrollTo(entry.anchorId)}
              style={{
                paddingInlineStart: `${(entry.level - 1) * 12 + 8}px`,
              }}
              type="button"
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
