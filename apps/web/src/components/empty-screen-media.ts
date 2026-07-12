import { env } from "@/env";

const MATTERS_VIDEO_ASPECT_RATIO = "2152 / 1080";
const MATTERS_VIDEO_POSTER_SRC = "/empty-states/matters-intro-poster.jpg";

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
