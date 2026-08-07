// Generates one Open Graph card per built page, drawn from that page's own
// <title>.
//
// The card and the page could each have stated the headline separately — a
// registry of paths to card text next to the titles the pages already carry —
// and the two would have drifted the first time a title was reworded. Instead
// Base.astro emits the card URL it wants and this hook reads the rendered HTML
// back: the set of cards generated is exactly the set of cards referenced, and
// the words on the card are the words in the tab.
//
// Cards are written into dist, not committed: at thirteen locales the site
// emits well over a hundred of them.
import type { AstroIntegration } from "astro";
import { panic } from "better-result";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderOgCard } from "../lib/og-card";
import {
  isGeneratedOgCard,
  OG_CARD_DIR,
  ogCardHeadline,
} from "../lib/og-card-path";

export const ogCards = (): AstroIntegration => ({
  name: "og-cards",
  hooks: {
    "astro:build:done": async ({ dir, logger, pages }) => {
      const requested = await Promise.all(
        pages.map(async ({ pathname }) => cardRequest(dir, pathname)),
      );

      const cards = new Map<string, CardRequest>();
      for (const request of requested) {
        if (request === undefined) {
          continue;
        }
        const claimed = cards.get(request.cardPath);
        if (claimed !== undefined && claimed.headline !== request.headline) {
          panic(
            `two pages flatten onto the card ${request.cardPath}: "${claimed.headline}" and "${request.headline}"`,
          );
        }
        cards.set(request.cardPath, request);
      }

      await mkdir(fileURLToPath(new URL(`.${OG_CARD_DIR}`, dir)), {
        recursive: true,
      });
      const pending = [...cards.values()];
      await Promise.all(
        Array.from({ length: RENDER_LANES }, async () => drain(dir, pending)),
      );
      logger.info(`generated ${cards.size} Open Graph cards`);
    },
  },
});

/**
 * Cards render a few at a time rather than all at once: each one holds a
 * 1200x630 RGBA buffer while it encodes, and a site of this many pages would
 * otherwise have every buffer live at the same moment.
 */
const RENDER_LANES = 8;

type CardRequest = {
  cardPath: string;
  headline: string;
  direction: "ltr" | "rtl";
};

/** What a built page asks for, or nothing if its card is a static asset. */
const cardRequest = async (
  dir: URL,
  pathname: string,
): Promise<CardRequest | undefined> => {
  const html = await readPage(dir, pathname);
  const cardPath = new URL(required(html, OG_IMAGE, `${pathname}: og:image`))
    .pathname;
  if (!isGeneratedOgCard(cardPath)) {
    return undefined;
  }
  return {
    cardPath,
    // The card mirrors whatever the page mirrors, read off the same <html dir>
    // the locale config already drives, so the two cannot disagree.
    direction:
      required(html, HTML_DIR, `${pathname}: <html dir>`) === "rtl"
        ? "rtl"
        : "ltr",
    headline: ogCardHeadline(
      decodeEntities(required(html, TITLE, `${pathname}: <title>`)),
    ),
  };
};

/** One render lane: takes the next card off the shared queue until it is empty. */
const drain = async (dir: URL, pending: CardRequest[]): Promise<void> => {
  const next = pending.pop();
  if (next === undefined) {
    return;
  }
  const { cardPath, direction, headline } = next;
  await writeFile(
    new URL(`.${cardPath}`, dir),
    await renderOgCard({ direction, headline }),
  );
  return drain(dir, pending);
};

/**
 * Both patterns read markup this repo emits (Base.astro), so a miss means the
 * layout changed and cards stopped being generated — which is exactly the
 * silent failure a social preview never surfaces. Fail the build instead.
 */
const TITLE = /<title>([^<]*)<\/title>/u;
const OG_IMAGE = /<meta property="og:image" content="([^"]*)"/u;
const HTML_DIR = /<html [^>]*dir="([^"]*)"/u;

const required = (html: string, pattern: RegExp, what: string): string =>
  pattern.exec(html)?.[1] ?? panic(`${what} not found in the built page`);

/** Astro escapes these five when interpolating a title into markup. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

const decodeEntities = (value: string): string =>
  value.replaceAll(
    /&(?:amp|lt|gt|quot|#39);/gu,
    (entity) => ENTITIES[entity] ?? entity,
  );

/**
 * `pages` reports route pathnames, not files: most pages are written as
 * `<path>/index.html`, but 404 is written as `404.html`.
 */
const readPage = async (dir: URL, pathname: string): Promise<string> => {
  const candidates = [
    new URL(`${pathname}index.html`, dir),
    new URL(`${pathname.replace(/\/$/u, "")}.html`, dir),
  ];
  const read = await Promise.all(
    candidates.map(async (candidate) =>
      readFile(candidate, "utf-8").catch(() => undefined),
    ),
  );
  return (
    read.find((html) => html !== undefined) ??
    panic(
      `built page /${pathname} not found at ${candidates.map((url) => url.pathname).join(" or ")}`,
    )
  );
};
