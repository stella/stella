import { panic } from "better-result";

/**
 * How long a trusted click or key press can back one view action. Handlers
 * that act on the gesture itself run well within it, including chart
 * selection, which fires from the click or key handler; script on a later
 * timer does not.
 */
export const VISUAL_GESTURE_WINDOW_MS = 1000;

/** The gestures that grant a token: a click or a key press. */
const VISUAL_GESTURE_EVENTS = ["click", "keydown"] as const;

type GestureEvent = { readonly isTrusted: boolean };

/** The fields the gate decides on, read from one dispatched event. */
export type GestureEventFields =
  | {
      readonly type: "keydown";
      /** True for the repeated key events of a held key. */
      readonly repeat: boolean;
    }
  | {
      readonly type: "click";
      /** Click count; 0 for a click the browser derives from a key press. */
      readonly detail: number;
    };

type GestureEventReader<Observed extends GestureEvent> = (
  event: Observed,
) => GestureEventFields | null;

type GestureEventPrototypes = {
  readonly event: object;
  readonly uiEvent: object;
  readonly keyboardEvent: object;
};

const accessorOf = (prototype: object, name: string) => {
  const getter: unknown = Reflect.get(
    Object.getOwnPropertyDescriptor(prototype, name) ?? {},
    "get",
  );
  return typeof getter === "function" ? getter : null;
};

/**
 * Captures the event accessors and `Reflect.apply` once, at startup before
 * any page script, so later changes to the prototypes or to
 * `Function.prototype` do not change what the gate reads. When an accessor is
 * missing, the reader reads nothing and the gate grants nothing.
 */
export const captureGestureEventReader = ({
  event,
  uiEvent,
  keyboardEvent,
}: GestureEventPrototypes): GestureEventReader<GestureEvent> => {
  const apply = Reflect.apply;
  const getType = accessorOf(event, "type");
  const getDetail = accessorOf(uiEvent, "detail");
  const getRepeat = accessorOf(keyboardEvent, "repeat");
  if (!getType || !getDetail || !getRepeat) {
    return () => null;
  }
  return (target) => {
    const type: unknown = apply(getType, target, []);
    if (type === "keydown") {
      const repeat: unknown = apply(getRepeat, target, []);
      return typeof repeat === "boolean" ? { type, repeat } : null;
    }
    if (type === "click") {
      const detail: unknown = apply(getDetail, target, []);
      return typeof detail === "number" ? { type, detail } : null;
    }
    return null;
  };
};

type GestureEventTarget<Observed extends GestureEvent> = {
  addEventListener: (
    type: (typeof VISUAL_GESTURE_EVENTS)[number],
    listener: (event: Observed) => void,
    options: { capture: true },
  ) => void;
};

type VisualGestureGateOptions<Observed extends GestureEvent> = {
  now: () => number;
  readEvent: GestureEventReader<Observed>;
  windowMs?: number;
};

/**
 * One view action per trusted gesture. Every trusted click or key press
 * grants a single token, which the next action spends; a token left unspent
 * for longer than the window lapses.
 */
export const createVisualGestureGate = <Observed extends GestureEvent>({
  now,
  readEvent,
  windowMs = VISUAL_GESTURE_WINDOW_MS,
}: VisualGestureGateOptions<Observed>) => {
  let grantedAt: number | null = null;
  // `isTrusted` is an own, unforgeable property of every event, read here
  // from the event the browser dispatched.
  let keyPressedAt: number | null = null;
  // A key press is one gesture: a held key's repeats and the click the
  // browser derives from Enter or Space on a control grant nothing more. A
  // click with no key press before it, such as one from assistive
  // technology, is a gesture of its own.
  const observe = (event: Observed) => {
    if (!event.isTrusted) {
      return;
    }
    const fields = readEvent(event);
    if (fields === null) {
      return;
    }
    const current = now();
    switch (fields.type) {
      case "keydown": {
        if (fields.repeat) {
          return;
        }
        keyPressedAt = current;
        break;
      }
      case "click": {
        if (fields.detail === 0) {
          const derived =
            keyPressedAt !== null && current - keyPressedAt < windowMs;
          keyPressedAt = null;
          if (derived) {
            return;
          }
        }
        break;
      }
      default: {
        fields satisfies never;
        panic("Unhandled gesture event");
      }
    }
    grantedAt = current;
  };
  return Object.freeze({
    observe,
    /**
     * Listens in the capture phase on the window, registered before any page
     * script, so a gesture is observed before page handlers see it.
     */
    listen: (target: GestureEventTarget<Observed>) => {
      for (const type of VISUAL_GESTURE_EVENTS) {
        target.addEventListener(type, observe, { capture: true });
      }
    },
    take: () => {
      if (grantedAt === null) {
        return false;
      }
      const elapsed = now() - grantedAt;
      grantedAt = null;
      return elapsed >= 0 && elapsed < windowMs;
    },
  });
};
