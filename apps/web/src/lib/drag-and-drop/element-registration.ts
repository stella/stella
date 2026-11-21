import {
  draggable as registerDraggable,
  dropTargetForElements as registerDropTarget,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { panic, Result } from "better-result";

const liveDraggables = new WeakMap<Element, symbol>();
const liveDropTargets = new WeakMap<Element, symbol>();

// Each registration owns its token, including cleanup after a recycled node.
type RegisterElementOptions<TOptions extends { element: Element }> = {
  kind: "draggable" | "drop target";
  name: string;
  params: TOptions;
  register: (params: TOptions) => () => void;
  registry: WeakMap<Element, symbol>;
};

const registerElement = <TOptions extends { element: Element }>({
  kind,
  name,
  params,
  register,
  registry,
}: RegisterElementOptions<TOptions>): (() => void) => {
  const { element } = params;
  const existing = registry.get(element);
  if (
    existing !== undefined &&
    (import.meta.env.DEV || import.meta.env.NODE_ENV === "test")
  ) {
    panic(
      `Element ${kind} conflict: "${existing.description ?? "registration"}" is already registered; "${name}" requires a distinct element.`,
    );
  }
  const token = Symbol(name);
  registry.set(element, token);
  const registration = Result.try(() => register(params));
  if (Result.isError(registration)) {
    if (registry.get(element) === token) {
      registry.delete(element);
    }
    panic("Element registration failed", registration.error);
  }
  let cleanup: (() => void) | null = registration.value;
  return () => {
    const release = cleanup;
    if (release === null) {
      return;
    }
    cleanup = null;
    const released = Result.try(release);
    if (registry.get(element) === token) {
      registry.delete(element);
    }
    if (Result.isError(released)) {
      panic("Element registration cleanup failed", released.error);
    }
  };
};

type DraggableOptions = Parameters<typeof registerDraggable>[0] & {
  name?: string;
};

export const draggable = ({
  name = "draggable",
  ...params
}: DraggableOptions) =>
  registerElement({
    kind: "draggable",
    name,
    params,
    register: registerDraggable,
    registry: liveDraggables,
  });

type DropTargetOptions = Parameters<typeof registerDropTarget>[0] & {
  name?: string;
};

export const dropTargetForElements = ({
  name = "drop target",
  ...params
}: DropTargetOptions) =>
  registerElement({
    kind: "drop target",
    name,
    params,
    register: registerDropTarget,
    registry: liveDropTargets,
  });
