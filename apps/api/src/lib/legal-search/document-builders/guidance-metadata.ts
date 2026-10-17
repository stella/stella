import { panic } from "better-result";

import type { GuidanceMetadata } from "@stll/legal-ast/document-ast";

import {
  SOFT_LAW_AUTHORITIES,
  type SoftLawAuthority,
  type SoftLawMetadata,
  type SoftLawStated,
} from "@/api/lib/legal-search/soft-law-types";

const statedOrNull = (stated: SoftLawStated<string>): string | null => {
  switch (stated.state) {
    case "stated": {
      return stated.value;
    }
    case "not_stated": {
      return null;
    }
    default: {
      stated satisfies never;
      return panic(`Unhandled stated value: ${String(stated)}`);
    }
  }
};

type GuidanceMetadataOfOptions = {
  authority: SoftLawAuthority;
  metadata: SoftLawMetadata;
};

/**
 * The AST metadata of a stored soft-law version. Every soft-law source is an
 * authority, so the issuer is one; what the source did not state stays
 * absent rather than defaulted.
 */
export const guidanceMetadataOf = ({
  authority,
  metadata,
}: GuidanceMetadataOfOptions): GuidanceMetadata => ({
  type: "guidance",
  kind: metadata.kind,
  title: metadata.title,
  reference: statedOrNull(metadata.statedReference),
  issuedOn: statedOrNull(metadata.issuedOn),
  issuer: {
    type: "authority",
    name: SOFT_LAW_AUTHORITIES[authority].name,
    jurisdiction: SOFT_LAW_AUTHORITIES[authority].jurisdiction,
  },
});
