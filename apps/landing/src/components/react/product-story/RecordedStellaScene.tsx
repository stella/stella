import { useSyncExternalStore } from "react";

import { cn } from "@stll/ui/lib/utils";

import {
  productStoryEditorPortraitMedia,
  productStoryHeroMedia,
  productStoryMedia,
  type ProductStoryMedia,
  type ProductStorySceneId,
} from "../../../data/product-story";

export const RecordedStellaScene = ({
  crop = "top",
  isActive = true,
  sceneId,
  variant = "wide",
}: RecordedStellaSceneProps) => {
  const isDark = useSyncExternalStore(
    subscribeToDocumentTheme,
    getDocumentTheme,
    getServerTheme,
  );
  const prefersReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionPreference,
    getServerMotionPreference,
  );
  const media = getSceneMedia(sceneId, variant);
  const posterSrc = isDark ? media.darkPosterSrc : media.posterSrc;
  const videoSrc = isDark ? media.darkVideoSrc : media.videoSrc;
  const shouldPlay = isActive && !prefersReducedMotion;

  if (!shouldPlay) {
    return (
      <img
        alt={media.alt}
        className={cn(
          "bg-background h-full w-full",
          crop === "top"
            ? "object-cover object-top"
            : "object-cover object-center",
        )}
        decoding="async"
        src={posterSrc}
      />
    );
  }

  return (
    <video
      aria-label={media.alt}
      autoPlay
      className={cn(
        "bg-background h-full w-full",
        crop === "top"
          ? "object-cover object-top"
          : "object-cover object-center",
      )}
      key={videoSrc}
      loop
      muted
      playsInline
      poster={posterSrc}
      preload="metadata"
    >
      <source src={videoSrc} type="video/mp4" />
      <img alt={media.alt} decoding="async" src={posterSrc} />
    </video>
  );
};

// Each variant is recorded at the aspect of the box it fills ("wide" 16:9 for
// scene-only embeds, "hero" ~1.674:1 for the companion composition's main
// window, "portrait" ~0.869:1 for the floating editor side window), so
// object-cover is only tolerance for sub-percent ratio drift. "top" anchors
// any residual crop to the app's toolbar edge; "document" keeps the page body
// centered in the editor side window.
type RecordedStellaSceneProps = {
  crop?: "document" | "top";
  isActive?: boolean;
} & (
  | { sceneId: "editor"; variant: "portrait" }
  | { sceneId: ProductStorySceneId; variant?: "hero" | "wide" }
);

type RecordedStellaSceneVariant = "hero" | "portrait" | "wide";

const getSceneMedia = (
  sceneId: ProductStorySceneId,
  variant: RecordedStellaSceneVariant,
): ProductStoryMedia => {
  if (variant === "portrait") {
    return productStoryEditorPortraitMedia;
  }
  if (variant === "hero") {
    return productStoryHeroMedia[sceneId];
  }
  return productStoryMedia[sceneId];
};

const getDocumentTheme = () =>
  document.documentElement.classList.contains("dark");

const getServerTheme = () => false;

const subscribeToDocumentTheme = (onStoreChange: () => void) => {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["class"],
    attributes: true,
  });
  return () => observer.disconnect();
};

const getReducedMotionPreference = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const getServerMotionPreference = () => true;

const subscribeToReducedMotion = (onStoreChange: () => void) => {
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
};
