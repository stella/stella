import { useMutation } from "@tanstack/react-query";
import type { MutateOptions, UseMutationOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { IDEMPOTENT_SUBMISSION } from "@/lib/idempotency/mutation-submission.logic";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";

type MutationSubmission<TVariables, TData> = {
  [IDEMPOTENT_SUBMISSION]: TVariables;
  execute: () => Promise<TData>;
};

type IdempotentMutationOptions<TData, TError, TVariables, TContext> = Omit<
  UseMutationOptions<TData, TError, TVariables, TContext>,
  "mutationFn"
> & {
  idempotencyScope?: string;
  mutationFn: (
    variables: TVariables,
    request: IdempotentRequest,
  ) => Promise<TData>;
};

const callbacksForSubmission = <TData, TError, TVariables, TContext>(
  callbacks: MutateOptions<TData, TError, TVariables, TContext> | undefined,
) =>
  ({
    onSuccess: (data, submission, result, context) =>
      callbacks?.onSuccess?.(
        data,
        submission[IDEMPOTENT_SUBMISSION],
        result,
        context,
      ),
    onError: (error, submission, result, context) =>
      callbacks?.onError?.(
        error,
        submission[IDEMPOTENT_SUBMISSION],
        result,
        context,
      ),
    onSettled: (...args) => {
      const [data, error, submission, result, context] = args;
      return callbacks?.onSettled?.(
        data,
        error,
        submission[IDEMPOTENT_SUBMISSION],
        result,
        context,
      );
    },
  }) satisfies MutateOptions<
    TData,
    TError,
    MutationSubmission<TVariables, TData>,
    TContext
  >;

/** Capture the intent before TanStack starts a mutation, so every automatic retry keeps its key. */
export const useIdempotentMutation = <
  TData,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>({
  mutationFn,
  idempotencyScope = "mutation",
  onMutate,
  onSuccess,
  onError,
  onSettled,
  ...options
}: IdempotentMutationOptions<TData, TError, TVariables, TContext>) => {
  const submit = useIdempotentSubmit();
  const mutation = useMutation({
    ...options,
    mutationFn: async (submission: MutationSubmission<TVariables, TData>) =>
      await submission.execute(),
    ...(onMutate === undefined
      ? {}
      : {
          onMutate: async (
            submission: MutationSubmission<TVariables, TData>,
            context: Parameters<typeof onMutate>[1],
          ) => await onMutate(submission[IDEMPOTENT_SUBMISSION], context),
        }),
    onSuccess: (data, submission, result, context) =>
      onSuccess?.(data, submission[IDEMPOTENT_SUBMISSION], result, context),
    onError: (error, submission, result, context) =>
      onError?.(error, submission[IDEMPOTENT_SUBMISSION], result, context),
    onSettled: (...args) => {
      const [data, error, submission, result, context] = args;
      return onSettled?.(
        data,
        error,
        submission[IDEMPOTENT_SUBMISSION],
        result,
        context,
      );
    },
  });
  const captureSubmission = (variables: TVariables) => {
    const operation = idempotencyScope;
    const send = mutationFn;
    const request = submit.prepare({ body: variables, operation });
    return {
      [IDEMPOTENT_SUBMISSION]: variables,
      execute: async () =>
        await submit.run({ body: variables, operation, request, send }),
    };
  };
  const actions = {
    mutate: (
      variables: TVariables,
      callbacks?: MutateOptions<TData, TError, TVariables, TContext>,
    ) => {
      mutation.mutate(
        captureSubmission(variables),
        callbacksForSubmission(callbacks),
      );
    },
    mutateAsync: async (
      variables: TVariables,
      callbacks?: MutateOptions<TData, TError, TVariables, TContext>,
    ) =>
      await mutation.mutateAsync(
        captureSubmission(variables),
        callbacksForSubmission(callbacks),
      ),
    reset: () => {
      submit.reset();
      mutation.reset();
    },
  };
  switch (mutation.status) {
    case "idle":
      return { ...mutation, ...actions, variables: undefined };
    case "pending":
      return {
        ...mutation,
        ...actions,
        variables: mutation.variables[IDEMPOTENT_SUBMISSION],
      };
    case "error":
      return {
        ...mutation,
        ...actions,
        variables: mutation.variables[IDEMPOTENT_SUBMISSION],
      };
    case "success":
      return {
        ...mutation,
        ...actions,
        variables: mutation.variables[IDEMPOTENT_SUBMISSION],
      };
    default:
      mutation satisfies never;
      return panic("Unhandled idempotent mutation status");
  }
};
