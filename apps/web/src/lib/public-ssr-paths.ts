import { createPathMatcher } from "@stll/ssr-kit";

import { publicToolsBasePath } from "@/lib/public-tools-path";

export const isPublicSsrPath = createPathMatcher([
  { type: "subtree", path: "/law" },
  { type: "subtree", path: publicToolsBasePath() },
]);
