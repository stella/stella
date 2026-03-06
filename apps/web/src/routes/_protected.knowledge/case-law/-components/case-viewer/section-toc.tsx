import { useTranslations } from "use-intl";

type Section = {
  index: number;
  type: string;
  title: string | null;
  text: string;
};

type SectionTocProps = {
  sections: Section[];
};

const SECTION_TYPE_KEYS = {
  argumentation: "caseLaw.sectionTypes.argumentation",
  dissent: "caseLaw.sectionTypes.dissent",
  footer: "caseLaw.sectionTypes.footer",
  header: "caseLaw.sectionTypes.header",
  history: "caseLaw.sectionTypes.history",
  ruling: "caseLaw.sectionTypes.ruling",
  unknown: "caseLaw.sectionTypes.unknown",
} as const;

export const SectionToc = ({ sections }: SectionTocProps) => {
  const t = useTranslations();

  const scrollToSection = (index: number) => {
    const element = document.getElementById(`section-${index}`);
    element?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const getSectionLabel = (section: Section) => {
    if (section.title) {
      return section.title;
    }
    const key =
      SECTION_TYPE_KEYS[section.type as keyof typeof SECTION_TYPE_KEYS];
    return key ? t(key) : t("caseLaw.sectionTypes.unknown");
  };

  return (
    <nav>
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
        {t("caseLaw.viewer.sections")}
      </h3>
      <ul className="space-y-0.5">
        {sections.map((section) => (
          <li key={section.index}>
            <button
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => scrollToSection(section.index)}
              type="button"
            >
              {getSectionLabel(section)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
