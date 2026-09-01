import { listen } from "@tauri-apps/api/event";
import type { EventCallback, EventName } from "@tauri-apps/api/event";

/**
 * Tauri types the unlisten function it resolves as `() => void`, although
 * calling it awaits an IPC round trip that can fail. The wider type is what
 * lets that rejection be handled instead of dropped.
 */
type StopListening = () => void | Promise<void>;

type SubscribeDesktopEventOptions<T> = {
  event: EventName;
  handler: EventCallback<T>;
  /** Runs when the subscription or its teardown fails. */
  onError: () => void;
  /** Runs once the subscription is live, before any event reaches `handler`. */
  onSubscribed?: () => void;
};

/**
 * Subscribes to a Tauri event and returns the canceller an effect cleanup calls.
 *
 * Both halves of a subscription cross IPC and can reject: `listen` itself, and
 * the unlisten function it resolves. A rejection dropped from either has
 * nowhere to go but the global unhandled-rejection handler, so both reach
 * `onError` here.
 *
 * Cancelling before the subscription resolves unsubscribes as soon as it does,
 * so a listener cannot outlive the effect that installed it.
 */
export const subscribeDesktopEvent = <T>({
  event,
  handler,
  onError,
  onSubscribed,
}: SubscribeDesktopEventOptions<T>) => {
  let unlisten: StopListening | undefined;
  let cancelled = false;
  const unsubscribe = (stopListening: StopListening) => {
    Promise.resolve(stopListening()).catch(onError);
  };
  listen<T>(event, handler)
    .then((stopListening) => {
      if (cancelled) {
        unsubscribe(stopListening);
        return undefined;
      }
      unlisten = stopListening;
      onSubscribed?.();
      return undefined;
    })
    .catch(onError);
  return () => {
    cancelled = true;
    if (unlisten) {
      unsubscribe(unlisten);
    }
  };
};
