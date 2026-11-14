import { useState } from "react";

import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createSubmitFingerprint } from "@/lib/idempotency/idempotent-submit-fingerprint";
import { createSubmitIntent } from "@/lib/idempotency/idempotent-submit.logic";
import { createUuid } from "@/lib/uuid";

export type IdempotentRequest = { headers: { "Idempotency-Key": string } };

type SubmitIntentOptions<TBody> = { body: TBody; operation: string };
type IdempotentSubmitOptions<TBody, TResult> = SubmitIntentOptions<TBody> & {
  request?: IdempotentRequest;
  send: (body: TBody, request: IdempotentRequest) => Promise<TResult>;
};

/** Failed attempts retain their keys; overlapping attempts replay in submission order. */
export const useIdempotentSubmit = () => {
  const user = useMaybeAuthenticatedUser();
  const scopeOperation = (operation: string) =>
    JSON.stringify([user?.id, user?.activeOrganizationId, operation]);
  const [fingerprint] = useState(() => createSubmitFingerprint(createUuid));
  const [intents] = useState(
    () => new Map<string, ReturnType<typeof createSubmitIntent>>(),
  );
  const [pending] = useState(() => new Map<string, Promise<void>>());
  const prepare = <TBody>({ body, operation }: SubmitIntentOptions<TBody>) => {
    const scope = scopeOperation(operation);
    let intent = intents.get(scope);
    if (intent === undefined) {
      intent = createSubmitIntent(createUuid);
      intents.set(scope, intent);
    }
    return {
      intent,
      request: intent.request(fingerprint(body)),
    };
  };
  return {
    prepare: <TBody>(options: SubmitIntentOptions<TBody>) =>
      prepare(options).request,
    run: async <TBody, TResult>({
      body,
      operation,
      request,
      send,
    }: IdempotentSubmitOptions<TBody, TResult>) => {
      const prepared =
        request === undefined
          ? prepare({ body, operation })
          : { intent: intents.get(scopeOperation(operation)), request };
      const capturedRequest = request ?? prepared.request;
      const key = capturedRequest.headers["Idempotency-Key"];
      const previous = pending.get(key);
      const execute = async () => {
        const result = await send(body, capturedRequest);
        if (!(
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          result.error !== null
        )) {
          prepared.intent?.complete(key);
        }
        return result;
      };
      const execution =
        previous === undefined ? execute() : previous.then(execute);
      const clear = (): void => {
        if (pending.get(key) === settled) {
          pending.delete(key);
        }
      };
      // Each execution reaches its caller; waiters only need its settlement to replay or retry.
      const settled = execution.then(clear, clear);
      pending.set(key, settled);
      return await execution;
    },
    reset: () => intents.clear(),
  };
};
