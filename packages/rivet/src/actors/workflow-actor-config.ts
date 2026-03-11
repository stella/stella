import type * as v from "valibot";

import { getActorRegion } from "../consts";
import type { CommonOptions, OptionsType } from "../types";
import { actorKeyFactory, authedActorParamsSchema } from "./common";
import type { AuthedActorOptions, AuthedActorReturn } from "./common";

export type WorkflowActorEvent =
  | {
      name: "panic";
      data?: never;
    }
  | {
      name: "workflow-status";
      data: {
        running: boolean;
      };
    }
  | {
      name: "field-content";
      data: {
        id: string;
        propertyId: string;
        entityId: string;
        content:
          | {
              version: 1;
              type: "error";
            }
          | {
              version: 1;
              type: "pending";
            }
          | {
              version: 1;
              type: "unsupported";
            }
          | {
              version: 1;
              type: "text";
              value: string;
            }
          | {
              version: 1;
              type: "single-select";
              value: string | null;
            }
          | {
              version: 1;
              type: "multi-select";
              value: string[];
            }
          | {
              version: 1;
              type: "date";
              value: string | null;
            }
          | {
              version: 1;
              type: "int";
              value: number;
              currency: string | null;
            }
          | null;
      }[];
    };

const [createActorKey, parseActorKey] = actorKeyFactory<{
  organizationId: string;
  workspaceId: string;
}>();
export const parseWorkflowActorKey = parseActorKey;

export const workflowActorParamsSchema = authedActorParamsSchema;
export type WorkflowActorParams = v.InferOutput<
  typeof workflowActorParamsSchema
>;

type WorkflowActorOptions<T extends OptionsType> = AuthedActorOptions<
  T,
  {
    workspaceId: string;
  }
>;
type WorkflowActorReturn<T extends OptionsType> = AuthedActorReturn<
  T,
  "workflow"
>;

export const getWorkflowActorConfig = <T extends OptionsType>(
  options: WorkflowActorOptions<T>,
): WorkflowActorReturn<T> => {
  const key = createActorKey({
    organizationId: options.organizationId,
    workspaceId: options.workspaceId,
  });
  const params: WorkflowActorParams = {
    authToken: options.authToken ?? "",
  };
  const commonOptions: CommonOptions = {
    createInRegion: getActorRegion(),
    params,
  };

  if (options.type === "react") {
    const clientOptions: WorkflowActorReturn<"react"> = {
      name: "workflow",
      key,
      enabled: !!options.authToken,
      ...commonOptions,
    };
    return clientOptions as WorkflowActorReturn<T>;
  }

  const vanillaOptions: WorkflowActorReturn<"vanilla"> = [[key], commonOptions];
  return vanillaOptions as WorkflowActorReturn<T>;
};
