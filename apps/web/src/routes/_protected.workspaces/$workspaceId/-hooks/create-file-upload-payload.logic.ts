import { toSafeId } from "@/lib/safe-id";

export type EntityCreatePresignPayloadInput = {
  propertyId: string;
  parentId?: string | null | undefined;
  name: string;
  mimeType: string;
  size: number;
  sha256Hex: string;
};

export const buildEntityCreatePresignPayload = ({
  propertyId,
  parentId,
  name,
  mimeType,
  size,
  sha256Hex,
}: EntityCreatePresignPayloadInput) => ({
  purpose: "entity_create" as const,
  propertyId: toSafeId<"property">(propertyId),
  parentId: parentId ? toSafeId<"entity">(parentId) : null,
  name,
  mimeType,
  size,
  sha256Hex,
});
