import { useSyncExternalStore } from "react";

import { cn } from "@stll/ui/lib/utils";

import {
  productStoryMedia,
  type ProductStorySceneId,
} from "../../../data/product-story";

export const RecordedStellaScene = ({
  crop = "full",
  isActive = true,
  sceneId,
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
  const media = productStoryMedia[sceneId];
  const posterSrc = isDark ? media.darkPosterSrc : media.posterSrc;
  const videoSrc = isDark ? media.darkVideoSrc : media.videoSrc;
  const shouldPlay = isActive && !prefersReducedMotion;

  if (!shouldPlay) {
    return (
      <img
        alt={media.alt}
        className={cn(
          "bg-background h-full w-full",
          crop === "full" ? "object-contain" : "object-cover object-center",
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
        crop === "full" ? "object-contain" : "object-cover object-center",
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

type RecordedStellaSceneProps = {
  crop?: "document" | "full";
  isActive?: boolean;
  sceneId: ProductStorySceneId;
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
