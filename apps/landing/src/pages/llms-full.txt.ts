import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { aiTagline, aiOverview, aiFaqs } from "../data/ai-facts";
import {
  primaryCapabilities,
  dataStackCapabilities,
  controlCapabilities,
} from "../data/capabilities";

// Full canonical content concatenated into one plain-text feed for LLM
// ingestion: overview, product capabilities, fact-sheet Q&A, and every
// published blog post. Pairs with the lighter /llms.txt index in public/.
export const GET: APIRoute = async () => {
  const posts = (await getCollection("blog"))
    .filter((post) => !post.data.draft)
    .sort(
      (a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
    );

  const sections: string[] = [
    "# stella — full content",
    "",
    `> ${aiTagline}`,
    "",
    "## Overview",
    "",
    ...aiOverview.flatMap((paragraph) => [paragraph, ""]),
    "## Core capabilities",
    "",
    ...primaryCapabilities.flatMap((cap) => [
      `### ${cap.title}`,
      "",
      cap.description,
      "",
    ]),
    "## Legal data stack",
    "",
    ...dataStackCapabilities.flatMap((cap) => [
      `### ${cap.title}`,
      "",
      cap.body,
      "",
    ]),
    "## Control and deployment",
    "",
    ...controlCapabilities.flatMap((cap) => [
      `- **${cap.title}**: ${cap.body}`,
    ]),
    "",
    "## Frequently asked questions",
    "",
    ...aiFaqs.flatMap((faq) => [`### ${faq.question}`, "", faq.answer, ""]),
    "## Blog",
    "",
    ...posts.flatMap((post) => [
      `### ${post.data.title}`,
      "",
      `Published ${post.data.publishedAt.toISOString().slice(0, 10)} · ${post.data.description}`,
      "",
      post.body?.trim() ?? "",
      "",
    ]),
  ];

  return new Response(sections.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
