import { useEffect, useState } from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { Button, buttonVariants } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import {
  CircleHelpIcon,
  ExternalLinkIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { env } from "@/env";
import { sanitizeHref } from "@/lib/sanitize-href";

const DEFAULT_SUPPORT_EMAIL = "hello@stll.app";
const MATTERS_VIDEO_ASPECT_RATIO = "2152 / 1080";
const MATTERS_VIDEO_POSTER_SRC = "/empty-states/matters-intro-poster.jpg";
export const EMPTY_SCREEN_PLACEHOLDER_YOUTUBE_URL =
  "https://www.youtube.com/watch?v=M7lc1UVf-VE";
export const EMPTY_SCREEN_MATTERS_VIDEO = env.VITE_EMPTY_STATE_MATTERS_VIDEO_URL
  ? ({
      type: "native",
      src: env.VITE_EMPTY_STATE_MATTERS_VIDEO_URL,
      aspectRatio: MATTERS_VIDEO_ASPECT_RATIO,
      captionsSrc: "/empty-states/matters-intro.vtt",
      poster: MATTERS_VIDEO_POSTER_SRC,
    } as const)
  : ({
      type: "image",
      src: MATTERS_VIDEO_POSTER_SRC,
      aspectRatio: MATTERS_VIDEO_ASPECT_RATIO,
    } as const);
export const EMPTY_SCREEN_TABLE_PREVIEW = {
  type: "image",
  src: "/empty-states/table-toolbar-preview.png",
  aspectRatio: "674 / 162",
} as const;

type EmptyScreenMediaPlacement = "side" | "bottom";

type EmptyScreenAction = {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
};

type EmptyScreenVideo = {
  title: string;
} & (
  | {
      type: "youtube";
      url: string;
    }
  | {
      type: "native";
      src: string;
      aspectRatio?: string;
      captionsSrc: string;
      poster?: string;
    }
  | {
      type: "preview";
    }
  | {
      type: "image";
      src: string;
      aspectRatio?: string;
    }
);

type EmptyScreenProps = {
  title: string;
  description: string;
  primaryAction: EmptyScreenAction;
  docsHref?: string;
  supportEmail?: string;
  video?: EmptyScreenVideo;
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
  video,
  preview,
  mediaPlacement = "side",
  mediaContainerClassName,
  showHelpBar = true,
  className,
}: EmptyScreenProps) => {
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const canPlayVideo = getPlayableVideo(video) !== undefined;
  const isBottomMedia = mediaPlacement === "bottom";

  return (
    <section
      className={cn(
        "relative flex min-h-[520px] flex-1 flex-col overflow-hidden px-6 py-12",
        isBottomMedia
          ? "items-center gap-8 pt-12 pb-28"
          : "items-center justify-center",
        className,
      )}
    >
      {isBottomMedia ? (
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
            <EmptyScreenMedia
              onPlay={() => setIsVideoOpen(true)}
              preview={preview}
              video={video}
            />
          </div>
        </>
      ) : (
        <div className="mx-auto grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
          <EmptyScreenMedia
            onPlay={() => setIsVideoOpen(true)}
            preview={preview}
            video={video}
          />
          <EmptyScreenContent
            description={description}
            docsHref={docsHref}
            primaryAction={primaryAction}
            title={title}
            variant="start"
          />
        </div>
      )}
      {showHelpBar && (
        <HelpBar docsHref={docsHref} supportEmail={supportEmail} />
      )}
      {canPlayVideo && isVideoOpen && video && (
        <EmptyScreenVideoOverlay
          onClose={() => setIsVideoOpen(false)}
          video={video}
        />
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
  video: EmptyScreenVideo | undefined;
  preview: ReactNode | undefined;
  onPlay: () => void;
};

const EmptyScreenMedia = ({
  video,
  preview,
  onPlay,
}: EmptyScreenMediaProps) => {
  const tCommon = useTranslations("common");
  const videoTitle = video?.title ?? tCommon("preview");
  const canPlay = getPlayableVideo(video) !== undefined;
  const mediaContent = (
    <EmptyScreenMediaContent
      preview={preview}
      video={video}
      videoTitle={videoTitle}
    />
  );

  return (
    <div className="border-border/80 bg-card/80 relative overflow-hidden rounded-xl border shadow-xs">
      <div className="border-border/70 bg-muted/40 flex h-8 items-center gap-1.5 border-b px-3">
        <span className="text-muted-foreground truncate text-xs">
          {videoTitle}
        </span>
      </div>
      {canPlay ? (
        <button
          aria-label={`${tCommon("playVideo")}: ${videoTitle}`}
          className="bg-muted/40 relative block aspect-video w-full cursor-pointer text-start"
          onClick={onPlay}
          style={getVideoAspectRatioStyle(video)}
          type="button"
        >
          {mediaContent}
          <span className="bg-background/88 text-foreground hover:bg-background focus-visible:ring-ring absolute inset-0 m-auto flex h-11 w-fit items-center gap-2 rounded-full border px-4 text-sm font-medium shadow-sm transition outline-none focus-visible:ring-2">
            <PlayIcon className="size-4 fill-current" />
            {tCommon("playVideo")}
          </span>
        </button>
      ) : (
        <div
          className="bg-muted/40 relative aspect-video"
          style={getVideoAspectRatioStyle(video)}
        >
          {mediaContent}
        </div>
      )}
    </div>
  );
};

type EmptyScreenMediaContentProps = {
  video: EmptyScreenVideo | undefined;
  preview: ReactNode | undefined;
  videoTitle: string;
};

const EmptyScreenMediaContent = ({
  video,
  preview,
  videoTitle,
}: EmptyScreenMediaContentProps): ReactNode => {
  const tCommon = useTranslations("common");

  if (video?.type === "native") {
    return (
      <video
        aria-hidden="true"
        className="size-full object-cover"
        muted
        poster={video.poster}
        preload="metadata"
      >
        <source src={video.src} />
        <track
          kind="captions"
          label={tCommon("captions")}
          src={video.captionsSrc}
          srcLang="en"
        />
      </video>
    );
  }

  if (video?.type === "image") {
    return (
      <img
        alt={videoTitle}
        className="size-full object-cover"
        src={video.src}
      />
    );
  }

  return preview ?? <DefaultEmptyPreview />;
};

type PlayableVideo =
  | {
      type: "youtube";
      src: string;
      title: string;
    }
  | {
      type: "native";
      src: string;
      aspectRatio: string | undefined;
      captionsSrc: string;
      title: string;
    };

const getPlayableVideo = (
  video: EmptyScreenVideo | undefined,
): PlayableVideo | undefined => {
  if (!video || video.type === "preview") {
    return undefined;
  }

  if (video.type === "image") {
    return undefined;
  }

  if (video.type === "native") {
    return {
      type: "native",
      src: video.src,
      aspectRatio: video.aspectRatio,
      captionsSrc: video.captionsSrc,
      title: video.title,
    };
  }

  const src = toYouTubeEmbedUrl(video.url);
  if (!src) {
    return undefined;
  }

  return {
    type: "youtube",
    src,
    title: video.title,
  };
};

const getVideoAspectRatioStyle = (
  video: EmptyScreenVideo | PlayableVideo | undefined,
): CSSProperties | undefined => {
  if (!video || !("aspectRatio" in video) || !video.aspectRatio) {
    return undefined;
  }

  return { aspectRatio: video.aspectRatio };
};

type EmptyScreenVideoOverlayProps = {
  video: EmptyScreenVideo;
  onClose: () => void;
};

const EmptyScreenVideoOverlay = ({
  video,
  onClose,
}: EmptyScreenVideoOverlayProps) => {
  const tCommon = useTranslations("common");
  const playableVideo = getPlayableVideo(video);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!playableVideo) {
    return null;
  }

  return (
    <div
      aria-label={playableVideo.title}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-6 backdrop-blur-sm"
      role="dialog"
    >
      <div className="border-border/80 bg-card relative w-full max-w-5xl overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border/70 bg-muted/40 flex h-8 items-center gap-1.5 border-b px-3">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {playableVideo.title}
          </span>
          <Button
            aria-label={tCommon("close")}
            className="size-6"
            onClick={onClose}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="bg-foreground">
          {playableVideo.type === "youtube" ? (
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="aspect-video w-full"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              src={playableVideo.src}
              title={playableVideo.title}
            />
          ) : (
            <video
              aria-label={playableVideo.title}
              autoPlay
              className="w-full"
              controls
              style={getVideoAspectRatioStyle(playableVideo)}
            >
              <source src={playableVideo.src} />
              <track
                kind="captions"
                label={tCommon("captions")}
                src={playableVideo.captionsSrc}
                srcLang="en"
              />
            </video>
          )}
        </div>
      </div>
    </div>
  );
};

const toYouTubeEmbedUrl = (url: string): string | undefined => {
  const safeUrl = sanitizeHref(url);
  if (!safeUrl || !URL.canParse(safeUrl)) {
    return undefined;
  }

  const parsed = new URL(safeUrl);
  const host = parsed.hostname.replace(/^www\./, "");
  const id = getYouTubeVideoId(host, parsed);
  if (!id) {
    return undefined;
  }

  return `https://www.youtube.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`;
};

const getYouTubeVideoId = (host: string, parsed: URL): string | undefined => {
  if (host === "youtu.be") {
    return normalizeYouTubeId(parsed.pathname.slice(1));
  }

  if (host === "youtube.com" || host === "m.youtube.com") {
    const watchId = parsed.searchParams.get("v");
    if (watchId) {
      return normalizeYouTubeId(watchId);
    }
    return getEmbedPathId(parsed);
  }

  if (host === "youtube-nocookie.com") {
    return getEmbedPathId(parsed);
  }

  return undefined;
};

const getEmbedPathId = (parsed: URL): string | undefined => {
  const [prefix, id] = parsed.pathname.split("/").filter(Boolean);
  if (prefix !== "embed") {
    return undefined;
  }
  return normalizeYouTubeId(id);
};

const normalizeYouTubeId = (id: string | undefined): string | undefined => {
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    return undefined;
  }
  return id;
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
    <Button disabled={action.disabled} onClick={action.onClick}>
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
    <div className="fixed inset-x-6 bottom-6 z-20 hidden [@media(min-height:820px)]:block">
      <div className="border-border/80 bg-background/85 text-muted-foreground mx-auto flex max-w-xl items-center justify-center gap-2 rounded-xl border px-4 py-3 text-center text-sm shadow-xs backdrop-blur">
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
