import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";
import {
  BanknoteIcon,
  CogIcon,
  ExternalLinkIcon,
  FileBadgeIcon,
  KeyRoundIcon,
  LinkIcon,
  TagIcon,
  UserIcon,
  XIcon,
  type LucideIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import Tooltip from "@/components/tooltip";
import type { KnowledgeToolDetail } from "@/features/knowledge/views/tools/tools-seam";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

type ToolDetailPanelViewProps = {
  tool: KnowledgeToolDetail;
  onClose: () => void;
  /** Long-form content after the summary, e.g. a tool's full documentation. */
  body?: ReactNode;
  /** The panel's actions; the footer bar renders only when given. */
  footer?: ReactNode;
  /** Dialogs the route owns. */
  children?: ReactNode;
};

export const ToolDetailPanelView = ({
  tool,
  onClose,
  body,
  footer,
  children,
}: ToolDetailPanelViewProps) => {
  const t = useTranslations();
  const isFirstParty = tool.author === "stella";
  const homepageUrl = sanitizeHref(tool.homepage ?? tool.authorUrl);
  const labelKey = nativeToolLabelKey({ slug: tool.slug, kind: tool.kind });

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header
        className={cn(
          "border-border flex shrink-0 items-center gap-2 border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <h2
          className="text-foreground min-w-0 truncate text-sm font-semibold"
          dir="auto"
        >
          {labelKey ? t(labelKey) : tool.displayName}
        </h2>
        {homepageUrl && (
          <a
            aria-label={t("catalogue.openHomepage")}
            className="text-muted-foreground hover:text-foreground shrink-0"
            href={sanitizeHref(tool.homepage ?? tool.authorUrl)}
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
        {tool.description && (
          <Section title={t("onboarding.catalogueDetailAbout")}>
            {/* Remount per entry so expanded/overflow state starts fresh
                (the panel itself is not remounted per selection). */}
            <ExpandableText key={tool.description} text={tool.description} />
          </Section>
        )}

        {tool.connection && (
          <Section title={t("catalogue.configuration")}>
            <div className="flex flex-col gap-2">
              <Field
                ariaLabel={t("knowledge.mcp.urlLabel")}
                icon={LinkIcon}
                value={tool.connection.url}
              />
              <Field
                ariaLabel={t("catalogue.detailAuthMethod")}
                icon={KeyRoundIcon}
                value={t(
                  `knowledge.mcp.auth.${authKey(tool.connection.authType)}`,
                )}
              />
              {tool.connection.serverVersion && (
                <Field
                  ariaLabel={t("common.version")}
                  icon={TagIcon}
                  value={tool.connection.serverVersion}
                />
              )}
            </div>
          </Section>
        )}

        {body}

        <div className="mt-auto flex flex-col gap-5">
          <Divider />
          <Section title={t("common.details")}>
            <div className="grid grid-cols-2 gap-3">
              <AuthorField
                ariaLabel={t("common.author")}
                authorUrl={tool.authorUrl}
                value={isFirstParty ? "stella" : tool.author}
              />
              {tool.license && (
                <Field
                  ariaLabel={t("onboarding.catalogueDetailLicense")}
                  icon={FileBadgeIcon}
                  value={tool.license}
                />
              )}
              {tool.cost && (
                <Field
                  ariaLabel={t("onboarding.catalogueDetailCost")}
                  icon={BanknoteIcon}
                  value={t(`catalogue.cost.${tool.cost}`)}
                />
              )}
              <Field
                ariaLabel={t("onboarding.catalogueDetailSetup")}
                icon={CogIcon}
                value={t(`catalogue.setup.${setupKey(tool.setup)}`)}
              />
            </div>
            {tool.jurisdictions.length > 0 && (
              <ChipRow
                ariaLabel={t("onboarding.catalogueDetailJurisdictions")}
                icon={TagIcon}
                values={tool.jurisdictions}
              />
            )}
          </Section>
        </div>
      </div>

      {footer !== undefined && (
        <footer
          className={cn(
            "border-border flex shrink-0 items-center gap-2 border-t px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          {footer}
        </footer>
      )}
      {children}
    </div>
  );
};

/**
 * About-text block that clamps long copy (e.g. server-reported MCP
 * `instructions`) to a few lines, with a Show more/less toggle. The
 * toggle only appears when the text actually overflows the clamp.
 */
const ExpandableText = ({ text }: { text: string }) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Measure only while clamped, so overflow is detected against the
  // line-clamp height. A ResizeObserver keeps it correct across font
  // loads, panel animation, and width changes.
  const textRef = useCallback(
    (el: HTMLParagraphElement | null) => {
      if (expanded || !el) {
        return undefined;
      }

      const measure = () => {
        setOverflowing(el.scrollHeight > el.clientHeight + 1);
      };

      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    },
    [expanded],
  );

  return (
    <div className="flex flex-col items-start gap-1.5">
      <p
        className={cn(
          "text-foreground text-sm leading-relaxed text-pretty",
          !expanded && "line-clamp-5",
        )}
        ref={textRef}
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <Button
          className="text-muted-foreground h-auto p-0"
          onClick={() => setExpanded((prev) => !prev)}
          size="sm"
          type="button"
          variant="link"
        >
          {expanded ? t("common.showLess") : t("common.showMore")}
        </Button>
      )}
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

const Field = ({ icon: Icon, ariaLabel, value }: FieldProps) => {
  const fieldLabel = `${ariaLabel}: ${value}`;

  return (
    <Tooltip
      className="max-w-80 text-start whitespace-normal"
      content={<FieldTooltipContent label={ariaLabel} value={value} />}
      render={
        <div
          aria-label={fieldLabel}
          className="flex w-fit max-w-full min-w-0 items-center gap-2"
          role="group"
        >
          <Icon
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0"
          />
          <span className="text-foreground min-w-0 truncate text-sm font-medium">
            {value}
          </span>
        </div>
      }
    />
  );
};

type AuthorFieldProps = {
  ariaLabel: string;
  authorUrl: string | undefined;
  value: string;
};

const AuthorField = ({ ariaLabel, authorUrl, value }: AuthorFieldProps) => {
  const safeAuthorUrl = sanitizeHref(authorUrl);
  const fieldLabel = `${ariaLabel}: ${value}`;
  const tooltipContent = (
    <FieldTooltipContent label={ariaLabel} value={value} />
  );
  const inner = (
    <>
      <UserIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="text-foreground min-w-0 truncate text-sm font-medium">
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
        className="max-w-80 text-start whitespace-normal"
        content={tooltipContent}
        render={
          <a
            aria-label={fieldLabel}
            className="hover:bg-muted -mx-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5"
            href={sanitizeHref(authorUrl)}
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
      className="max-w-80 text-start whitespace-normal"
      content={tooltipContent}
      render={
        <div
          aria-label={fieldLabel}
          className="flex w-fit max-w-full min-w-0 items-center gap-2"
          role="group"
        >
          {inner}
        </div>
      }
    />
  );
};

type FieldTooltipContentProps = {
  label: string;
  value: string;
};

const FieldTooltipContent = ({ label, value }: FieldTooltipContentProps) => (
  <span className="flex flex-col gap-1">
    <span className="text-xs opacity-75">{label}</span>
    <span className="text-xs font-medium break-all">{value}</span>
  </span>
);

type ChipRowProps = {
  icon: LucideIcon;
  ariaLabel: string;
  values: readonly string[];
};

const ChipRow = ({ icon: Icon, ariaLabel, values }: ChipRowProps) => (
  <Tooltip
    content={ariaLabel}
    render={
      <div
        aria-label={ariaLabel}
        className="flex w-fit items-center gap-2"
        role="group"
      >
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
