import { useMutationState } from "@tanstack/react-query";
import type { MutationFilters, MutationState } from "@tanstack/react-query";

import { readMutationVariables } from "@/lib/idempotency/mutation-submission.logic";

type ObservedMutationStateOptions<TResult> = {
  filters?: MutationFilters;
  select: (state: MutationState) => TResult;
};

/** Readers see submitted variables independently of the create transport envelope. */
export const useObservedMutationState = <TResult>({
  filters,
  select,
}: ObservedMutationStateOptions<TResult>) =>
  useMutationState({
    ...(filters === undefined ? {} : { filters }),
    select: (mutation) =>
      select({
        ...mutation.state,
        variables: readMutationVariables(mutation.state.variables),
      }),
  });
