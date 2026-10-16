type EuLegislationClassification = {
  documentType: "regulation" | "directive" | "decision" | "treaty" | "charter";
  subtype: "ordinary" | "delegated" | "implementing" | "legacy";
};

/** Publisher resource types, independent of CELEX identifier syntax. */
export const EU_LEGISLATION_RESOURCE_TYPES = {
  REG: { documentType: "regulation", subtype: "ordinary" },
  REG_DEL: { documentType: "regulation", subtype: "delegated" },
  REG_IMPL: { documentType: "regulation", subtype: "implementing" },
  // Financial regulations remain regulations; this code states no delegation.
  REG_FINANC: { documentType: "regulation", subtype: "ordinary" },
  DIR: { documentType: "directive", subtype: "ordinary" },
  DIR_DEL: { documentType: "directive", subtype: "delegated" },
  DIR_IMPL: { documentType: "directive", subtype: "implementing" },
  DEC: { documentType: "decision", subtype: "ordinary" },
  DEC_DEL: { documentType: "decision", subtype: "delegated" },
  DEC_IMPL: { documentType: "decision", subtype: "implementing" },
  DEC_ENTSCHEID: { documentType: "decision", subtype: "legacy" },
  TREATY: { documentType: "treaty", subtype: "ordinary" },
} as const satisfies Record<string, EuLegislationClassification>;

export const EU_SOFT_LAW_RESOURCE_TYPES = [
  "COMMUNIC",
  "GUIDELINE",
  "NOTICE",
  "INFO",
] as const;

export type EuResourceTypeDisposition =
  | ({ type: "legislation" } & EuLegislationClassification)
  | { type: "soft-law"; owner: "soft-law" }
  | { type: "unsupported"; resourceType: string };

const RESOURCE_TYPE_AUTHORITY_PREFIX =
  "http://publications.europa.eu/resource/authority/resource-type/";

const isLegislationResourceType = (
  resourceType: string,
): resourceType is keyof typeof EU_LEGISLATION_RESOURCE_TYPES =>
  Object.hasOwn(EU_LEGISLATION_RESOURCE_TYPES, resourceType);

type ClassifyEuResourceTypeOptions = {
  resourceType: string;
  publisherCelexType?: string;
};

export const classifyEuResourceType = ({
  resourceType: rawResourceType,
  publisherCelexType,
}: ClassifyEuResourceTypeOptions): EuResourceTypeDisposition => {
  const resourceType = rawResourceType.startsWith(
    RESOURCE_TYPE_AUTHORITY_PREFIX,
  )
    ? rawResourceType.slice(RESOURCE_TYPE_AUTHORITY_PREFIX.length)
    : rawResourceType;
  if (isLegislationResourceType(resourceType)) {
    const classification = EU_LEGISLATION_RESOURCE_TYPES[resourceType];
    return {
      type: "legislation",
      documentType:
        resourceType === "TREATY" && publisherCelexType === "P"
          ? "charter"
          : classification.documentType,
      subtype: classification.subtype,
    };
  }
  if (
    EU_SOFT_LAW_RESOURCE_TYPES.some((candidate) => candidate === resourceType)
  ) {
    return { type: "soft-law", owner: "soft-law" };
  }
  // Corrigenda need a separate expression-language correction contract.
  return { type: "unsupported", resourceType };
};
