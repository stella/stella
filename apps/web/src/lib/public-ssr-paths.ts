import { createPathMatcher } from "@stll/ssr-kit";

export const isPublicSsrPath = createPathMatcher([
  { type: "subtree", path: "/law" },
  { type: "subtree", path: "/tools" },
]);
