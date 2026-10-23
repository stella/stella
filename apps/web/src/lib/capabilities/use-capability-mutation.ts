import { useMutation } from "@tanstack/react-query";
import type { DefaultError, UseMutationOptions } from "@tanstack/react-query";

import { toResourceName } from "@stll/api-contract";
import type { ResourceRef } from "@stll/api-contract";

import type { CapabilityId } from "@/lib/api";
import { capabilityRequest } from "@/lib/capabilities/capability-request";
import type { CapabilityRequest } from "@/lib/capabilities/capability-request";
import { useScreenAction } from "@/lib/capabilities/screen-actions";

type UseCapabilityMutationOptions<TData, TError, TVariables, TOnMutateResult> =
  Omit<
    UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
    "mutationFn"
  > & {
    capability: CapabilityId;
    /** The resource the mounted control offers this capability on. */
    target: ResourceRef;
    mutationFn: (
      variables: TVariables,
      request: CapabilityRequest,
    ) => Promise<TData>;
  };

/**
 * A TanStack mutation that runs as a catalog capability: `mutationFn` receives
 * the request options declaring `capability`, and the mounted control is
 * listed as an available action on `target`.
 */
export const useCapabilityMutation = <
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>({
  capability,
  target,
  mutationFn,
  ...options
}: UseCapabilityMutationOptions<
  TData,
  TError,
  TVariables,
  TOnMutateResult
>) => {
  useScreenAction({ capability, resource: toResourceName(target) });
  return useMutation({
    ...options,
    mutationFn: async (variables: TVariables) =>
      await mutationFn(variables, capabilityRequest(capability)),
  });
};
