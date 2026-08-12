import { panic } from "better-result";

import {
  parseResourceRef,
  resourceRef,
  RESOURCE_TYPE,
  type ResourceRef,
} from "@stll/api-contract";

import { toSafeId } from "@/lib/safe-id";

export type EntityLinkResourceInput = {
  id: string;
  /** Optional only while older API replicas may omit canonical identity. */
  resource?: unknown;
};

export const getEntityLinkResource = ({
  id,
  resource: resourceValue,
}: EntityLinkResourceInput): ResourceRef<"entity"> => {
  if (resourceValue === undefined) {
    return resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">(id),
    });
  }

  const resource = parseResourceRef(resourceValue);
  if (
    resource === null ||
    resource.type !== RESOURCE_TYPE.ENTITY ||
    resource.id !== id
  ) {
    return panic("Entity link identity disagrees with its legacy ID");
  }

  return resource;
};
