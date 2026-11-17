/**
 * Quickwit binary that built every final q09 corpus generation. It is part of
 * each generation's manifest digest, so it never moves for a generation that
 * already exists; a generation built by another binary declares its own.
 */
export const QUICKWIT_V09_BUILD_VERSION = "0.9.0";

/**
 * The one search engine image: the Quickwit build the local stack and CI run
 * against q09 generations, upstream main at `commit`, published as a public
 * image and pinned by digest. docker-compose.yml and the `quickwit` entry of
 * scripts/ci-service-images.json name exactly `image`; moving the engine
 * changes all three together.
 */
export const QUICKWIT_V09_RUNTIME = {
  version: "0.9.0",
  commit: "5f83b0bfaf7ed2a67a29de3cd09995ab828e711b",
  image:
    "ghcr.io/stella/quickwit:main-5f83b0bfaf7ed2a67a29de3cd09995ab828e711b@sha256:c87f789f5867360b8958fb38ab74b6dc61afd26c029d5c3b424494091b5917ed",
} as const;
