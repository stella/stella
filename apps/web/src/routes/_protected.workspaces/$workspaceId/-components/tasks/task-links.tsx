import { LinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

// -- Linked entity row --

const LinkedEntityRow = ({ name, kind }: { name: string; kind: string }) => (
  <div className="flex items-center gap-2 rounded px-1 py-0.5 text-sm">
    <LinkIcon className="text-muted-foreground size-3" />
    <span className="truncate">{name}</span>
    <span className="text-muted-foreground text-xs">{kind}</span>
  </div>
);

// -- Links section --

type EntityRef = {
  id: string;
  name: string | null;
  kind: string;
};

type LinksSectionProps = {
  linkedFrom: { targetEntity: EntityRef }[];
  linkedTo: { sourceEntity: EntityRef }[];
};

export const LinksSection = ({ linkedFrom, linkedTo }: LinksSectionProps) => {
  const t = useTranslations("tasks");

  if (linkedFrom.length === 0 && linkedTo.length === 0) {
    return null;
  }

  return (
    <div className="border-t px-4 py-3">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">
        {t("linkedEntities")}
      </h3>
      <div className="space-y-1">
        {linkedFrom.map((link) => (
          <LinkedEntityRow
            key={link.targetEntity.id}
            kind={link.targetEntity.kind}
            name={link.targetEntity.name ?? "Untitled"}
          />
        ))}
        {linkedTo.map((link) => (
          <LinkedEntityRow
            key={link.sourceEntity.id}
            kind={link.sourceEntity.kind}
            name={link.sourceEntity.name ?? "Untitled"}
          />
        ))}
      </div>
    </div>
  );
};
