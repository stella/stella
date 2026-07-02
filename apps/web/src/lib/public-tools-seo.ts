import {
  createPublicCanonicalUrl,
  createPublicHead,
  type PublicHeadInput,
} from "@/lib/public-seo";
import { isPublicToolsIndexingEnabled } from "@/lib/public-tools-launch";

type PublicToolsHeadInput = Omit<PublicHeadInput, "indexingEnabled"> & {
  indexingEnabled?: boolean;
};

export const createPublicToolsCanonicalUrl = createPublicCanonicalUrl;

export const createPublicToolsHead = ({
  indexingEnabled = isPublicToolsIndexingEnabled(),
  ...rest
}: PublicToolsHeadInput) => createPublicHead({ indexingEnabled, ...rest });
