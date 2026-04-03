import type * as v from "valibot";

import { getActorRegion } from "../consts";
import type { CommonOptions, OptionsType } from "../types";
import { actorKeyFactory, authedActorParamsSchema } from "./common";
import type { AuthedActorOptions, AuthedActorReturn } from "./common";

type ViewData = {
  version: number;
  id: string;
  name: string;
  layout: string;
  config: Record<string, unknown>;
  position: number;
  createdAt: string;
};

export type ViewsActorEvent =
  | {
      name: "views-changed";
      data: { views: ViewData[] };
    }
  | {
      name: "view-deleted";
      data: { viewId: string };
    };

const [createActorKey, parseActorKey] = actorKeyFactory<{
  organizationId: string;
  workspaceId: string;
}>();
export const parseViewsActorKey = parseActorKey;

export const viewsActorParamsSchema = authedActorParamsSchema;
export type ViewsActorParams = v.InferOutput<typeof viewsActorParamsSchema>;

type ViewsActorOptions<T extends OptionsType> = AuthedActorOptions<
  T,
  {
    workspaceId: string;
  }
>;
type ViewsActorReturn<T extends OptionsType> = AuthedActorReturn<T, "views">;

export const getViewsActorConfig = <T extends OptionsType>(
  options: ViewsActorOptions<T>,
): ViewsActorReturn<T> => {
  const key = createActorKey({
    organizationId: options.organizationId,
    workspaceId: options.workspaceId,
  });
  const params: ViewsActorParams = {
    authToken: options.authToken ?? "",
  };
  const region = getActorRegion();
  const commonOptions: CommonOptions = {
    ...(region && { createInRegion: region }),
    params,
  };

  if (options.type === "react") {
    const clientOptions: ViewsActorReturn<"react"> = {
      name: "views",
      key,
      enabled: !!options.authToken,
      ...commonOptions,
    };
    // SAFETY: framework type erasure; options satisfy ViewsActorReturn
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    return clientOptions as ViewsActorReturn<T>;
  }

  const vanillaOptions: ViewsActorReturn<"vanilla"> = [[key], commonOptions];
  // SAFETY: framework type erasure; vanillaOptions satisfies ViewsActorReturn
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return vanillaOptions as ViewsActorReturn<T>;
};
