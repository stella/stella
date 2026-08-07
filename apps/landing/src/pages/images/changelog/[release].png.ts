import type { APIRoute } from "astro";

import type { ChangelogRelease } from "../../../lib/changelog";
import { getChangelogReleases } from "../../../lib/changelog";
import { renderOgCard } from "../../../lib/og-card";

export const getStaticPaths = () =>
  getChangelogReleases().map((release) => ({
    params: { release: release.slug },
    props: { release },
  }));

// Release cards are the one page kind whose card is not its title: the title
// reads "v0.6.29: Search in chat history", while the card sets the heading
// large and the version as a badge, so the version stays legible at feed size.
export const GET: APIRoute<{ release?: ChangelogRelease }> = async ({
  props,
}) => {
  if (props.release === undefined) {
    return new Response(null, { status: 404 });
  }

  const { heading, tagName } = props.release;
  const version = tagName.replace(/^v/u, "");
  const card = await renderOgCard(
    heading === null || heading === ""
      ? { headline: version }
      : { badge: version, headline: heading },
  );

  return new Response(new Uint8Array(card), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
    },
  });
};
