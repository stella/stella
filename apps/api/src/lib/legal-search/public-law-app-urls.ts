import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteInput } from "@stll/api-contract/case-law-decision-route";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";
import type { StatuteRouteInput } from "@stll/api-contract/statute-route";

import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";

export const buildCaseLawDecisionAppUrl = (
  input: CaseLawDecisionRouteInput,
): string | null =>
  isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW")
    ? buildCaseLawDecisionUrl(input)
    : null;

/**
 * The route shape is owned by `@stll/api-contract/case-law-decision-route`, so
 * an agent-facing URL and the web route cannot address different pages: a
 * decision without a stored slug links by id, not by case number.
 */
export const buildCaseLawDecisionUrl = (input: CaseLawDecisionRouteInput) =>
  `${getAppBaseUrl()}${createCaseLawDecisionPath(createCaseLawDecisionRouteParams(input))}`;

/**
 * A statute's canonical public address: its stored slug, or the id form when
 * the corpus holds none. A version and provision anchor preserve a dated read. The
 * route shape is owned by `@stll/api-contract/statute-route`, so the address
 * a tool reports and the page the web serves cannot diverge. Null only when
 * the public-law surface is off.
 */
export const buildLegislationDocumentAppUrl = ({
  country,
  documentId,
  eli,
  slug,
  version = null,
  anchor,
}: Omit<StatuteRouteInput, "version"> & {
  version?: string | null;
  anchor?: string;
}): string | null =>
  isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW")
    ? `${getAppBaseUrl()}${createStatutePath(
        createStatuteRouteParams({
          country,
          documentId,
          eli,
          slug,
          version,
        }),
      )}${anchor === undefined ? "" : `#${encodeURIComponent(anchor)}`}`
    : null;
