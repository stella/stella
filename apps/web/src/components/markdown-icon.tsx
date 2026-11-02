import type { ComponentProps } from "react";

import { DocumentMark } from "@stll/ui/document-mark";

// The Markdown mark in a square 24×24 viewBox so it drops into the same
// size-4 slots as lucide file icons.
export const MarkdownIcon = (
  props: Omit<ComponentProps<typeof DocumentMark>, "kind">,
) => <DocumentMark {...props} kind="markdown" />;
