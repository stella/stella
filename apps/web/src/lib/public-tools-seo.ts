import {
  createPublicCanonicalUrl,
  createPublicHead,
  type JsonLdObject,
  type PublicHeadInput,
} from "@/lib/public-seo";
import { isPublicToolsIndexingEnabled } from "@/lib/public-tools-launch";
import { spdxLicenseUrl } from "@/routes/tools/-components/tool-detail.logic";

type PublicToolsHeadInput = Omit<PublicHeadInput, "indexingEnabled"> & {
  indexingEnabled?: boolean;
};

export const createPublicToolsCanonicalUrl = createPublicCanonicalUrl;

export const createPublicToolsHead = ({
  indexingEnabled = isPublicToolsIndexingEnabled(),
  ...rest
}: PublicToolsHeadInput) => createPublicHead({ indexingEnabled, ...rest });

type ToolEntryJsonLdInput = {
  author: string;
  authorUrl?: string | undefined;
  canonicalUrl: string;
  cost: "free" | "paid";
  description: string;
  homepage?: string | undefined;
  kind: "skill" | "mcp" | "native-tool";
  license: string;
  name: string;
};

const APPLICATION_CATEGORY_BY_KIND = {
  skill: "BusinessApplication",
  mcp: "DeveloperApplication",
  "native-tool": "BusinessApplication",
} as const satisfies Record<ToolEntryJsonLdInput["kind"], string>;

/**
 * `SoftwareApplication` JSON-LD for a catalogue entry. Skills, MCP
 * servers, and native tools are all installable software with an author
 * and a license, which maps to `SoftwareApplication` far better than the
 * generic `CreativeWork`: it carries `applicationCategory`, `offers`,
 * and `softwareRequirements`, and is eligible for software rich results.
 * `offers` with price 0 marks free entries; paid (incl. BYOK) entries
 * omit an offer rather than assert a price Stella does not set.
 */
export const createToolEntryJsonLd = ({
  author,
  authorUrl,
  canonicalUrl,
  cost,
  description,
  homepage,
  kind,
  license,
  name,
}: ToolEntryJsonLdInput): JsonLdObject => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  applicationCategory: APPLICATION_CATEGORY_BY_KIND[kind],
  author: {
    "@type": "Organization",
    name: author,
    ...(authorUrl ? { url: authorUrl } : {}),
  },
  description,
  license: spdxLicenseUrl(license),
  name,
  url: canonicalUrl,
  ...(homepage ? { sameAs: homepage } : {}),
  ...(cost === "free"
    ? {
        offers: {
          "@type": "Offer",
          price: 0,
          priceCurrency: "USD",
        },
      }
    : {}),
});
