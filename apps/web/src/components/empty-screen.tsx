import type { ComponentProps, ReactNode } from "react";

import { CircleHelpIcon, ExternalLinkIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { buttonVariants } from "@stll/ui/button-variants";
import { cn } from "@stll/ui/utils";

import type { GuideAnchorProps } from "@/features/guides/guide-anchor";
import { sanitizeHref } from "@/lib/sanitize-href";

const DEFAULT_SUPPORT_EMAIL = "hello@stll.app";

type EmptyScreenMediaPlacement = "side" | "bottom";

type EmptyScreenAction = GuideAnchorProps & {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
};

type EmptyScreenProps = {
  title: string;
  description: string;
  primaryAction: EmptyScreenAction;
  docsHref?: string;
  supportEmail?: string;
  preview?: ReactNode;
  mediaPlacement?: EmptyScreenMediaPlacement;
  mediaContainerClassName?: string;
  showHelpBar?: boolean;
  className?: string;
};

export const EmptyScreen = ({
  title,
  description,
  primaryAction,
  docsHref,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
  preview,
  mediaPlacement = "side",
  mediaContainerClassName,
  showHelpBar = true,
  className,
}: EmptyScreenProps) => {
  const hasMedia = preview !== undefined;
  const isBottomMedia = mediaPlacement === "bottom";
  const sizeClass = hasMedia
    ? "min-h-[520px] flex-1 px-6 py-12"
    : "min-h-0 px-4 py-12 sm:py-16";
  const helpBarPaddingClass = showHelpBar
    ? "[@media(min-height:820px)]:pb-28"
    : undefined;
  let layoutClass = "items-center justify-center";

  if (hasMedia && isBottomMedia) {
    layoutClass = "items-center gap-8 pt-12 pb-28";
  }

  let body: ReactNode;

  if (!hasMedia) {
    body = (
      <EmptyScreenContent
        description={description}
        docsHref={docsHref}
        primaryAction={primaryAction}
        title={title}
        variant="center"
      />
    );
  } else if (isBottomMedia) {
    body = (
      <>
        <EmptyScreenContent
          description={description}
          docsHref={docsHref}
          primaryAction={primaryAction}
          title={title}
          variant="center"
        />
        <div
          className={cn(
            "mx-auto mt-auto w-full max-w-3xl",
            mediaContainerClassName,
          )}
        >
          <EmptyScreenMedia preview={preview} />
        </div>
      </>
    );
  } else {
    body = (
      <div className="mx-auto grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <EmptyScreenMedia preview={preview} />
        <EmptyScreenContent
          description={description}
          docsHref={docsHref}
          primaryAction={primaryAction}
          title={title}
          variant="start"
        />
      </div>
    );
  }

  return (
    <section
      className={cn(
        "relative flex flex-col overflow-hidden",
        sizeClass,
        layoutClass,
        helpBarPaddingClass,
        className,
      )}
    >
      {body}
      {showHelpBar && (
        <HelpBar docsHref={docsHref} supportEmail={supportEmail} />
      )}
    </section>
  );
};

type EmptyScreenContentProps = {
  title: string;
  description: string;
  primaryAction: EmptyScreenAction;
  docsHref: string | undefined;
  variant: "start" | "center";
};

const EmptyScreenContent = ({
  title,
  description,
  primaryAction,
  docsHref,
  variant,
}: EmptyScreenContentProps) => {
  const tCommon = useTranslations("common");
  const isCenter = variant === "center";

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-md flex-col",
        isCenter ? "items-center text-center" : "items-start text-start",
      )}
    >
      <h2 className="text-foreground text-2xl font-semibold tracking-normal">
        {title}
      </h2>
      <p className="text-muted-foreground mt-4 text-lg leading-7">
        {description}
      </p>
      <div
        className={cn(
          "mt-7 flex flex-wrap items-center gap-3",
          isCenter && "justify-center",
        )}
      >
        <EmptyScreenActionButton action={primaryAction} />
        {docsHref && (
          <a
            className={cn(buttonVariants({ variant: "outline" }))}
            href={sanitizeHref(docsHref)}
          >
            <ExternalLinkIcon />
            {tCommon("documentation")}
          </a>
        )}
      </div>
    </div>
  );
};

type EmptyScreenMediaProps = {
  preview: ReactNode | undefined;
};

const EmptyScreenMedia = ({ preview }: EmptyScreenMediaProps) => {
  const tCommon = useTranslations("common");

  return (
    <div className="border-border/80 bg-card/80 relative overflow-hidden rounded-xl border shadow-xs">
      <div className="border-border/70 bg-muted/40 flex h-8 items-center gap-1.5 border-b px-3">
        <span className="text-muted-foreground truncate text-xs">
          {tCommon("preview")}
        </span>
      </div>
      <div className="bg-muted/40 relative aspect-video">
        {preview ?? <DefaultEmptyPreview />}
      </div>
    </div>
  );
};

const DefaultEmptyPreview = () => (
  <div className="flex size-full flex-col gap-3 p-6">
    <div className="border-border/70 bg-background/80 h-10 rounded-md border" />
    <div className="grid flex-1 grid-cols-[0.38fr_1fr] gap-3">
      <div className="border-border/60 bg-background/60 rounded-md border" />
      <div className="border-border/60 bg-background/80 flex flex-col gap-2 rounded-md border p-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            className="bg-muted h-6 rounded"
            key={`empty-preview-row-${index}`}
          />
        ))}
      </div>
    </div>
  </div>
);

type EmptyScreenActionButtonProps = {
  action: EmptyScreenAction;
};

const EmptyScreenActionButton = ({ action }: EmptyScreenActionButtonProps) => {
  const Icon = action.icon;
  const guideAnchorId = action["data-guide-anchor"];
  const children = (
    <>
      {Icon && <Icon />}
      {action.label}
    </>
  );

  if (action.href) {
    const href = sanitizeHref(action.href);

    return (
      <a
        aria-disabled={action.disabled}
        className={cn(
          buttonVariants(),
          action.disabled && "pointer-events-none opacity-64",
        )}
        href={href}
        data-guide-anchor={guideAnchorId}
        onClick={(event) => {
          if (action.disabled) {
            event.preventDefault();
          }
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <Button
      data-guide-anchor={guideAnchorId}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {children}
    </Button>
  );
};

type HelpBarProps = {
  docsHref: string | undefined;
  supportEmail: string;
};

const HelpBar = ({ docsHref, supportEmail }: HelpBarProps) => {
  const tEmptyScreen = useTranslations("common.emptyScreen");

  return (
    // Anchored to the EmptyScreen section (which is `relative`), not the
    // viewport: `fixed` centred the bar across the whole window, so on a split
    // view it drifted out of the empty pane and straddled the divider.
    <div className="pointer-events-none absolute inset-x-6 bottom-6 z-20 hidden [@media(min-height:820px)]:block">
      <div className="border-border/80 bg-background/85 text-muted-foreground pointer-events-auto mx-auto flex max-w-xl items-center justify-center gap-2 rounded-xl border px-4 py-3 text-center text-sm shadow-xs backdrop-blur">
        <CircleHelpIcon className="text-primary size-4 shrink-0" />
        <span>
          {tEmptyScreen("needHelp")}{" "}
          {docsHref && (
            <>
              <InlineLink href={sanitizeHref(docsHref)}>
                {tEmptyScreen("viewDocumentation")}
              </InlineLink>{" "}
              {tEmptyScreen("orLetUsKnowAt")}{" "}
            </>
          )}
          {!docsHref && `${tEmptyScreen("letUsKnowAt")} `}
          <InlineLink href={sanitizeHref(`mailto:${supportEmail}`)}>
            {supportEmail}
          </InlineLink>
        </span>
      </div>
    </div>
  );
};

type InlineLinkProps = ComponentProps<"a">;

const InlineLink = ({ children, className, ...props }: InlineLinkProps) => (
  <a
    className={cn(
      "text-primary focus-visible:ring-ring rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2",
      className,
    )}
    {...props}
  >
    {children}
  </a>
);
