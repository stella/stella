import type { CSSProperties, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { displayLanguageName } from "@stll/locales";
import { Button } from "@stll/ui/button";
import { ContextMenu } from "@stll/ui/context-menu";
import type { ContextMenuAction } from "@stll/ui/context-menu";
import { MoreHorizontalIcon, PencilLineIcon } from "@stll/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { UserIdentityAvatar } from "@/components/user-avatar";
import type {
  KnowledgeTemplate,
  TemplateRowActions,
} from "@/features/knowledge/views/templates/templates-seam";
import { useI18nStore } from "@/i18n/i18n-store";
import { formatRelativeTime } from "@/lib/relative-time";

export type TemplateDensity = "compact" | "comfortable";

type TemplateRowViewProps = {
  template: KnowledgeTemplate;
  categoryName: string | null;
  density: TemplateDensity;
  actions: TemplateRowActions;
  /** Row-scoped dialogs the route owns, kept inside the row's list item. */
  children?: ReactNode;
};

/** Renders a single `ContextMenuAction` inside the ⋯ dropdown, mirroring the
 *  right-click `ContextMenu` so both surfaces stay driven by one array. */
const DropdownActionItem = ({ action }: { action: ContextMenuAction }) => {
  const separator = action.separatorBefore ? <DropdownMenuSeparator /> : null;

  if (action.submenu) {
    return (
      <>
        {separator}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {action.icon}
            {action.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {action.submenu.map((sub) => (
              <DropdownActionItem action={sub} key={sub.label} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </>
    );
  }

  return (
    <>
      {separator}
      <DropdownMenuItem
        className={cn(
          action.variant === "destructive" && "text-destructive-foreground",
        )}
        disabled={action.disabled === true}
        onClick={action.onClick}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
};

/** Stable hue (0–359) from a category id, so each category gets a consistent
 *  low-chroma tint and otherwise-identical rows become scannable. */
const categoryHue = (categoryId: string): number => {
  let hue = 0;
  for (const char of categoryId) {
    hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hue;
};

/** The template's initial in a rounded square, tinted by its category (the one
 *  accent per row). The hue rides in a CSS variable so the oklch classes can
 *  pick theme-appropriate lightness; uncategorized templates stay neutral. */
const TemplateMonogram = ({
  name,
  categoryId,
}: {
  name: string;
  categoryId: string | null;
}) => {
  const initial = (name.trim().at(0) ?? "?").toUpperCase();
  if (categoryId === null) {
    return (
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold">
        {initial}
      </div>
    );
  }
  // CSSProperties has no index signature for CSS custom properties, so widen
  // the binding rather than cast; --cat-hue feeds the oklch() classes.
  const style: CSSProperties & { "--cat-hue": string } = {
    "--cat-hue": String(categoryHue(categoryId)),
  };
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[oklch(0.94_0.045_var(--cat-hue))] text-sm font-semibold text-[oklch(0.45_0.13_var(--cat-hue))] dark:bg-[oklch(0.32_0.05_var(--cat-hue))] dark:text-[oklch(0.85_0.11_var(--cat-hue))]"
      style={style}
    >
      {initial}
    </div>
  );
};

export const TemplateRowView = ({
  template,
  categoryName,
  density,
  actions,
  children,
}: TemplateRowViewProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);

  // Trailing cluster — fixed width so it lines up across rows. `relative z-10`
  // keeps Use / ⋯ clickable above the row-wide open affordance (the name
  // button's stretched ::after). Opening the template is the whole-row click,
  // mirroring the clause list; Use (fill) stays an explicit CTA.
  const trailing = (
    <div className="relative z-10 flex shrink-0 items-center gap-2">
      {actions.use && (
        <Button
          className="max-sm:hidden"
          onClick={actions.use}
          size="xs"
          variant="outline"
        >
          {t("templates.useTemplate")}
        </Button>
      )}
      {template.authorName !== undefined && (
        <span className="hidden sm:inline-flex">
          <Tooltip
            content={template.authorName}
            render={<span className="inline-flex" />}
          >
            <UserIdentityAvatar
              className="size-6 shrink-0 text-[0.5625rem]"
              image={template.authorImage}
              name={template.authorName}
            />
          </Tooltip>
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={t("common.actions")}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {actions.menu.map((action) => (
            <DropdownActionItem action={action} key={action.label} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <li className="group">
      <ContextMenu actions={actions.menu}>
        <div
          className={cn(
            density === "compact"
              ? "hover:bg-muted/50 relative flex cursor-pointer items-center gap-3 px-4 py-2"
              : "hover:bg-muted/50 relative flex cursor-pointer items-start gap-3 px-4 py-3",
          )}
          draggable={actions.dragStart !== undefined}
          onDragStart={actions.dragStart}
        >
          <TemplateMonogram
            categoryId={template.categoryId}
            name={template.name}
          />

          {density === "compact" ? (
            <>
              <button
                className="flex min-w-0 flex-1 items-baseline gap-2 text-start after:absolute after:inset-0"
                onClick={actions.open}
                type="button"
              >
                <span className="truncate text-sm font-medium" dir="auto">
                  {template.name}
                </span>
                {categoryName !== null && (
                  <span
                    className="text-muted-foreground shrink-0 truncate text-xs"
                    dir="auto"
                  >
                    {categoryName}
                  </span>
                )}
              </button>
              {trailing}
            </>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-3">
                <button
                  className="flex min-w-0 flex-1 text-start after:absolute after:inset-0"
                  onClick={actions.open}
                  type="button"
                >
                  <span className="truncate text-sm font-medium" dir="auto">
                    {template.name}
                  </span>
                </button>
                {trailing}
              </div>
              <RowDescription
                categoryName={categoryName}
                onDescribe={actions.describe}
                template={template}
              />
              <RowStats lang={lang} template={template} />
            </div>
          )}
        </div>
      </ContextMenu>

      {children}
    </li>
  );
};

// ── Row metadata (muted, small) ──────────────────────

/** Endonym from the shared language list, with an Intl fallback localized to
 *  the UI language for tags outside the canonical list. */
export const languageDisplayName = (tag: string, uiLang: string): string =>
  displayLanguageName(tag, { displayLocale: uiLang });

type RowStatsProps = {
  template: KnowledgeTemplate;
  lang: string;
};

// Always-visible secondary stats (comfortable density only): language chips
// plus field/usage counts and the last-updated time. Usage and times the
// source does not know are left out.
const RowStats = ({ template, lang }: RowStatsProps) => {
  const t = useTranslations();

  const segments: string[] = [
    t("templates.fieldCount", { count: template.fieldCount }),
  ];
  if (template.useCount !== undefined && template.useCount > 0) {
    segments.push(t("templates.usedTimes", { count: template.useCount }));
  }
  if (template.lastUsedAt) {
    segments.push(
      t("templates.lastUsedAgo", {
        time: formatRelativeTime(template.lastUsedAt),
      }),
    );
  }
  if (template.updatedAt !== undefined) {
    segments.push(
      t("templates.updatedAgo", {
        time: formatRelativeTime(template.updatedAt),
      }),
    );
  }

  return (
    <span className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums">
      {template.languages.length > 0 && (
        <span className="flex items-center gap-1">
          {template.languages.map((tag) => (
            <span
              aria-label={languageDisplayName(tag, lang)}
              className="bg-muted text-3xs rounded px-1.5 py-0.5 font-medium uppercase"
              key={tag}
              role="group"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      <span className="truncate">{segments.join(" · ")}</span>
    </span>
  );
};

type RowDescriptionProps = {
  template: KnowledgeTemplate;
  categoryName: string | null;
  /** Present when the viewer may edit the guidance. */
  onDescribe: (() => void) | undefined;
};

// Category + "when to use" guidance (comfortable density only). Falls back to
// a quiet nudge to add guidance when none is set and the user can edit.
const RowDescription = ({
  template,
  categoryName,
  onDescribe,
}: RowDescriptionProps) => {
  const t = useTranslations();

  const guidance = template.whenToUse?.trim() ?? "";

  // Editable "when to use": a pencil-led button that opens the guidance dialog.
  // `relative z-10` keeps it clickable above the row-wide open affordance, so
  // editing guidance is distinct from opening the template. When the user can't
  // edit, show plain text (or nothing if there is no guidance).
  const detail = (() => {
    if (onDescribe) {
      return (
        <button
          className="hover:text-foreground relative z-10 inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
          onClick={onDescribe}
          type="button"
        >
          <PencilLineIcon className="size-3 shrink-0" />
          <span className="truncate">
            {guidance === "" ? t("templates.describeWhenToUse") : guidance}
          </span>
        </button>
      );
    }
    if (guidance !== "") {
      return <span className="truncate">{guidance}</span>;
    }
    return null;
  })();

  if (categoryName === null && detail === null) {
    return null;
  }

  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      {categoryName !== null && (
        <span className="text-foreground shrink-0 font-medium">
          {categoryName}
        </span>
      )}
      {categoryName !== null && detail !== null && <span aria-hidden>·</span>}
      {detail}
    </span>
  );
};
