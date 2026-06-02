import {
  BanknoteIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LinkIcon,
  LoaderIcon,
  PencilIcon,
  ScaleIcon,
  Settings2Icon,
  TagIcon,
  UserIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { sanitizeHref } from "@/lib/sanitize-href";

import { isEffectivelyInstalled, type CatalogueEntry } from "./catalogue-types";

type CatalogueDetailPanelProps = {
  entry: CatalogueEntry;
  installing: boolean;
  removing: boolean;
  onInstall: () => void;
  onRemove: () => void;
  onClose: () => void;
  /**
   * Open the full skill editor sheet. Only invoked for installed
   * skill entries; safe to omit on surfaces that don't expose editing.
   */
  onEditSkill?: (() => void) | undefined;
};

export const CatalogueDetailPanel = ({
  entry,
  installing,
  removing,
  onInstall,
  onRemove,
  onClose,
  onEditSkill,
}: CatalogueDetailPanelProps) => {
  const t = useTranslations();
  const isFirstParty = entry.author === "stella";
  const installed = isEffectivelyInstalled(entry);
  const installable = !installed && entry.installState !== "unavailable";
  const canRemove =
    installed &&
    !entry.isLocked &&
    (entry.kind === "native-tool" ||
      (entry.kind === "mcp" && entry.installedConnectorSlug !== null) ||
      (entry.kind === "skill" && entry.installedSkillId !== null));
  const homepageUrl = sanitizeHref(entry.homepage ?? entry.authorUrl);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header
        className={cn(
          "border-border flex shrink-0 items-center gap-2 border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <h2 className="text-foreground min-w-0 truncate text-sm font-semibold">
          {entry.displayName}
        </h2>
        {homepageUrl && (
          <a
            aria-label={t("catalogue.openHomepage")}
            className="text-muted-foreground hover:text-foreground shrink-0"
            href={homepageUrl}
            onClick={(e) => e.stopPropagation()}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        )}
        <Button
          aria-label={t("common.close")}
          className="ms-auto shrink-0"
          onClick={onClose}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        <Section title={t("onboarding.catalogueDetailAbout")}>
          <p className="text-foreground text-sm leading-relaxed text-pretty">
            {entry.description}
          </p>
        </Section>

        {installed && entry.kind === "mcp" && (
          <Section title={t("catalogue.configuration")}>
            <div className="flex flex-col gap-2">
              <Field
                ariaLabel={t("knowledge.mcp.urlLabel")}
                icon={LinkIcon}
                value={entry.url}
              />
              <Field
                ariaLabel={t("catalogue.detailAuthMethod")}
                icon={KeyRoundIcon}
                value={t(`knowledge.mcp.auth.${authKey(entry.authType)}`)}
              />
            </div>
          </Section>
        )}

        <div className="mt-auto flex flex-col gap-5">
          <Divider />
          <Section title={t("common.details")}>
            <div className="grid grid-cols-2 gap-3">
              <AuthorField
                ariaLabel={t("onboarding.catalogueDetailAuthor")}
                authorUrl={entry.authorUrl}
                value={isFirstParty ? "stella" : entry.author}
              />
              <Field
                ariaLabel={t("onboarding.catalogueDetailLicense")}
                icon={ScaleIcon}
                value={entry.license}
              />
              <Field
                ariaLabel={t("onboarding.catalogueDetailCost")}
                icon={BanknoteIcon}
                value={t(`catalogue.cost.${entry.cost}`)}
              />
              <Field
                ariaLabel={t("onboarding.catalogueDetailSetup")}
                icon={Settings2Icon}
                value={t(`catalogue.setup.${setupKey(entry.setup)}`)}
              />
            </div>
            {entry.jurisdictions.length > 0 && (
              <ChipRow
                ariaLabel={t("onboarding.catalogueDetailJurisdictions")}
                icon={TagIcon}
                values={entry.jurisdictions}
              />
            )}
          </Section>
        </div>
      </div>

      <footer
        className={cn(
          "border-border flex shrink-0 items-center gap-2 border-t px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        {installable && (
          <Button
            className="flex-1"
            disabled={installing}
            onClick={onInstall}
            type="button"
          >
            {installing && <LoaderIcon className="size-4 animate-spin" />}
            {t("catalogue.add")}
          </Button>
        )}
        {installed &&
          entry.kind === "skill" &&
          entry.installedSkillId !== null &&
          onEditSkill && (
            <Button
              className="flex-1"
              onClick={onEditSkill}
              type="button"
              variant="outline"
            >
              <PencilIcon className="size-4" />
              {t("knowledge.agentSkills.editSkill")}
            </Button>
          )}
        {canRemove && (
          <Button
            className="flex-1"
            disabled={removing}
            onClick={onRemove}
            type="button"
            variant="destructive-outline"
          >
            {removing && <LoaderIcon className="size-4 animate-spin" />}
            {t("common.remove")}
          </Button>
        )}
        {installed && !canRemove && (
          <p className="text-muted-foreground flex-1 text-center text-xs">
            {t("catalogue.installedShort")}
          </p>
        )}
        {entry.installState === "unavailable" && (
          <p className="text-muted-foreground flex-1 text-center text-xs">
            {t("catalogue.unavailable")}
          </p>
        )}
      </footer>
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="flex flex-col gap-2.5">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
      {title}
    </h3>
    {children}
  </section>
);

type FieldProps = {
  icon: LucideIcon;
  ariaLabel: string;
  value: string;
};

const Field = ({ icon: Icon, ariaLabel, value }: FieldProps) => (
  <Tooltip
    content={ariaLabel}
    render={
      <div aria-label={ariaLabel} className="flex w-fit items-center gap-2">
        <Icon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <span className="text-foreground truncate text-sm font-medium">
          {value}
        </span>
      </div>
    }
  />
);

type AuthorFieldProps = {
  ariaLabel: string;
  authorUrl: string | undefined;
  value: string;
};

const AuthorField = ({ ariaLabel, authorUrl, value }: AuthorFieldProps) => {
  const safeAuthorUrl = sanitizeHref(authorUrl);
  const inner = (
    <>
      <UserIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="text-foreground truncate text-sm font-medium">
        {value}
      </span>
      {safeAuthorUrl && (
        <ExternalLinkIcon
          aria-hidden="true"
          className="text-muted-foreground size-3 shrink-0"
        />
      )}
    </>
  );

  if (safeAuthorUrl) {
    return (
      <Tooltip
        content={ariaLabel}
        render={
          <a
            aria-label={ariaLabel}
            className="hover:bg-muted -mx-1 flex w-fit items-center gap-2 rounded-md px-1 py-0.5 transition-colors"
            href={safeAuthorUrl}
            onClick={(e) => e.stopPropagation()}
            rel="noreferrer"
            target="_blank"
          >
            {inner}
          </a>
        }
      />
    );
  }

  return (
    <Tooltip
      content={ariaLabel}
      render={
        <div aria-label={ariaLabel} className="flex w-fit items-center gap-2">
          {inner}
        </div>
      }
    />
  );
};

type ChipRowProps = {
  icon: LucideIcon;
  ariaLabel: string;
  values: readonly string[];
};

const ChipRow = ({ icon: Icon, ariaLabel, values }: ChipRowProps) => (
  <Tooltip
    content={ariaLabel}
    render={
      <div aria-label={ariaLabel} className="flex w-fit items-center gap-2">
        <Icon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              className="bg-muted text-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
              key={value}
            >
              {value}
            </span>
          ))}
        </div>
      </div>
    }
  />
);

const Divider = () => <div className="bg-border h-px w-full" />;

const authKey = (authType: "none" | "bearer" | "oauth") => {
  if (authType === "bearer") {
    return "bearer" as const;
  }
  if (authType === "oauth") {
    return "oauth2" as const;
  }
  return "none" as const;
};

const setupKey = (setup: string) => {
  if (setup === "api-key") {
    return "apiKey" as const;
  }
  if (setup === "account") {
    return "account" as const;
  }
  return "none" as const;
};
