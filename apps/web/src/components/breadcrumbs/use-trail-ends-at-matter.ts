import { useMatches } from "@tanstack/react-router";

import { trailEndsAtMatter } from "@/components/breadcrumbs/app-breadcrumbs.logic";

/** The header's matter actions read this one rule; see `trailEndsAtMatter`. */
export const useTrailEndsAtMatter = () =>
  useMatches({ select: trailEndsAtMatter });
