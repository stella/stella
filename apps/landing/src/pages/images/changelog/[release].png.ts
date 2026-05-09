import type { APIRoute } from "astro";

import { getChangelogReleases } from "../../../lib/changelog";
import { renderChangelogOgImage } from "../../../lib/changelog-og";

export const getStaticPaths = () =>
  getChangelogReleases().map((release) => ({
    params: { release: release.slug },
    props: { release },
  }));

export const GET: APIRoute = ({ params }) => {
  const release = getChangelogReleases().find(
    (changelogRelease) => changelogRelease.slug === params.release,
  );

  if (!release) {
    return new Response(null, { status: 404 });
  }

  return new Response(new Uint8Array(renderChangelogOgImage(release)), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
    },
  });
};
