import type { APIRoute } from "astro";

import type { ChangelogRelease } from "../../../lib/changelog";
import { getChangelogReleases } from "../../../lib/changelog";
import { renderChangelogOgImage } from "../../../lib/changelog-og";

export const getStaticPaths = () =>
  getChangelogReleases().map((release) => ({
    params: { release: release.slug },
    props: { release },
  }));

export const GET: APIRoute<{ release?: ChangelogRelease }> = ({ props }) => {
  if (props.release === undefined) {
    return new Response(null, { status: 404 });
  }

  return new Response(new Uint8Array(renderChangelogOgImage(props.release)), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
    },
  });
};
