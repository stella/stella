"use client";

import * as React from "react";

import { Toast } from "@base-ui/react/toast";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";

import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "../icons";
import { SAFE_AREA_TOAST_GEOMETRY_CLASS_NAME } from "../lib/safe-area";
import { cn } from "../lib/utils";
import { buttonVariants } from "./button";
import { Loader } from "./loader";
import { ScrollArea } from "./scroll-area";

type ToastData = {
  tooltipStyle?: boolean;
};

const toastManager = Toast.createToastManager<ToastData>();
const anchoredToastManager = Toast.createToastManager<ToastData>();

const TOAST_RIGHT_OFFSET_VAR = "--stella-toast-right-offset";
const ERROR_TOAST_TIMEOUT_MS = 8000;

const TOAST_ICONS = {
  error: <CircleAlertIcon className="text-destructive" />,
  info: <InfoIcon className="text-info" />,
  loading: null,
  neutral: null,
  success: <CircleCheckIcon className="text-success" />,
  warning: <TriangleAlertIcon className="text-warning" />,
} as const;

type ToastType = keyof typeof TOAST_ICONS;

type ToastAction = {
  label: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
};

type ToastActionProps = ToastManagerAddOptions<ToastData>["actionProps"];

type ToastOptions = Omit<
  ToastManagerAddOptions<ToastData>,
  "actionProps" | "title" | "type"
> & {
  action?: ToastAction;
  actionProps?: ToastActionProps;
};

type ToastUpdateOptions = Partial<ToastOptions> & {
  title?: React.ReactNode | undefined;
  type?: ToastType | undefined;
};

type ToastPromiseMessage = React.ReactNode | ToastUpdateOptions;

type ToastPromiseOptions<Value> = {
  error: ToastPromiseMessage | ((error: unknown) => ToastPromiseMessage);
  loading: ToastPromiseMessage;
  success: ToastPromiseMessage | ((value: Value) => ToastPromiseMessage);
};

type ToastApi = {
  (title: React.ReactNode, options?: ToastOptions): string;
  add: (options: ToastAddOptions) => string;
  close: (id?: string) => void;
  dismiss: (id?: string) => void;
  error: (title: React.ReactNode, options?: ToastOptions) => string;
  info: (title: React.ReactNode, options?: ToastOptions) => string;
  loading: (title: React.ReactNode, options?: ToastOptions) => string;
  promise: <Value>(
    promiseValue: Promise<Value>,
    options: ToastPromiseOptions<Value>,
  ) => Promise<Value>;
  success: (title: React.ReactNode, options?: ToastOptions) => string;
  update: (id: string, options: ToastUpdateOptions) => void;
  warning: (title: React.ReactNode, options?: ToastOptions) => string;
};

type ToastAddOptions = ToastUpdateOptions & {
  title: React.ReactNode;
};

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

type ToastProviderProps = {
  position?: ToastPosition;
} & Toast.Provider.Props;

const stellaToast: ToastApi = Object.assign(
  (title: React.ReactNode, options?: ToastOptions) =>
    addToast(title, undefined, options),
  {
    add: (options: ToastAddOptions) =>
      toastManager.add(
        normalizeToastAddOptions({
          ...options,
          id: options.id ?? toastDedupeId(options),
        }),
      ),
    close: (id?: string) => {
      toastManager.close(id);
    },
    dismiss: (id?: string) => {
      if (id === undefined) {
        toastManager.close();
        return;
      }

      toastManager.close(id);
    },
    error: (title: React.ReactNode, options?: ToastOptions) =>
      addToast(title, "error", options),
    info: (title: React.ReactNode, options?: ToastOptions) =>
      addToast(title, "info", options),
    loading: (title: React.ReactNode, options?: ToastOptions) =>
      addToast(title, "loading", options),
    promise: async <Value,>(
      promiseValue: Promise<Value>,
      options: ToastPromiseOptions<Value>,
    ) => {
      const toastId = stellaToast.loading(
        getPromiseToastTitle(options.loading),
        getPromiseToastOptions(options.loading),
      );

      try {
        const value = await promiseValue;

        stellaToast.update(
          toastId,
          getPromiseToastUpdateOptions(options.success, value, "success"),
        );

        return value;
      } catch (error) {
        stellaToast.update(
          toastId,
          getPromiseToastUpdateOptions(options.error, error, "error"),
        );

        throw error;
      }
    },
    success: (title: React.ReactNode, options?: ToastOptions) =>
      addToast(title, "success", options),
    update: (id: string, options: ToastUpdateOptions) => {
      toastManager.update(id, normalizeToastUpdateOptions(options));
    },
    warning: (title: React.ReactNode, options?: ToastOptions) =>
      addToast(title, "warning", options),
  },
);

const ToastProvider = ({
  children,
  position = "bottom-right",
  ...props
}: ToastProviderProps) => (
  <Toast.Provider toastManager={toastManager} {...props}>
    {children}
    <Toasts position={position} />
  </Toast.Provider>
);

const Toasts = ({ position }: { position: ToastPosition }) => {
  const { toasts } = Toast.useToastManager<ToastData>();
  const isTop = position.startsWith("top");
  const windowFocused = React.useSyncExternalStore(
    subscribeWindowFocus,
    readWindowFocus,
    readServerWindowFocus,
  );

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          // z-[90]: above the floating document composer and its blur veil
          // (chrome, z-[80]) so an error toast is never painted behind the
          // glass, and above dialogs (z-[85]) so a toast raised by a dialog's
          // own action stays readable; still below actively-open context
          // menus (z-[100]). See @stll/ui/overlay-layer for the ladder.
          "fixed z-[90] mx-auto flex max-w-90 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          SAFE_AREA_TOAST_GEOMETRY_CLASS_NAME,
          // Vertical positioning, clear of the status bar and home indicator
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--safe-area-top))]",
          "data-[position*=bottom]:bottom-[calc(var(--toast-inset)+var(--safe-area-bottom))]",
        )}
        data-position={position}
        data-slot="toast-viewport"
        data-window-blurred={windowFocused ? undefined : ""}
      >
        {toasts.map((toastItem) => (
          <Toast.Root
            className={cn(
              "bg-popover text-popover-foreground absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full rounded-lg border shadow-lg/5 [transition:transform_300ms_var(--ease-out),opacity_300ms_var(--ease-out),height_150ms_var(--ease-out)] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:[transition-duration:200ms,200ms,150ms] motion-reduce:transition-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
              // Base positioning using data-position
              "data-[position*=right]:start-auto data-[position*=right]:end-0",
              "data-[position*=left]:start-0 data-[position*=left]:end-auto",
              "data-[position*=center]:start-0 data-[position*=center]:end-0",
              "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
              "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
              // Gap fill for hover
              "after:absolute after:start-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
              "data-[position*=top]:after:top-full",
              "data-[position*=bottom]:after:bottom-full",
              // Define some variables
              "[--toast-calc-height:var(--toast-frontmost-height,var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
              // Define offset-y variable
              "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
              "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
              // Default state transform
              "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
              "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
              // Limited state
              "data-limited:opacity-0",
              // Expanded state
              "data-expanded:h-(--toast-height)",
              "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
              // Starting and ending animations
              "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
              "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
              "data-ending-style:opacity-0",
              // Ending animations (direction-aware)
              "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
              "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
              "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
              "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
              "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              // Ending animations (expanded)
              "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
              "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
              "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
              "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
            )}
            data-position={position}
            key={toastItem.id}
            swipeDirection={(() => {
              if (position.includes("center")) {
                return [isTop ? "up" : "down"];
              }
              if (position.includes("left")) {
                return ["left", isTop ? "up" : "down"];
              }
              return ["right", isTop ? "up" : "down"];
            })()}
            toast={toastItem}
          >
            <Toast.Content className="pointer-events-auto flex items-center gap-3 px-3.5 py-3 text-sm transition-opacity duration-250 select-text data-behind:opacity-0 data-behind:not-data-expanded:pointer-events-none data-expanded:opacity-100">
              <div className="flex min-w-0 flex-1 gap-2">
                <ToastIcon type={toastItem.type} />

                <ScrollArea
                  axis="vertical"
                  className="h-auto min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]]:max-h-[60dvh]"
                >
                  <div className="flex min-w-0 flex-col gap-0.5 select-text">
                    <Toast.Title
                      className="font-medium wrap-anywhere whitespace-pre-wrap"
                      data-slot="toast-title"
                    />
                    <Toast.Description
                      className="text-muted-foreground wrap-anywhere whitespace-pre-wrap"
                      data-slot="toast-description"
                    />
                  </div>
                </ScrollArea>
              </div>
              <div className="ms-auto flex shrink-0 items-center gap-2">
                {toastItem.actionProps && (
                  <Toast.Action
                    className={cn(
                      buttonVariants({ size: "xs" }),
                      "select-none",
                    )}
                    data-slot="toast-action"
                  >
                    {toastItem.actionProps.children}
                  </Toast.Action>
                )}
                <Toast.Close
                  className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded p-0.5 select-none"
                  data-slot="toast-close"
                  aria-label="Close notification"
                >
                  <XIcon className="size-4" />
                </Toast.Close>
              </div>
              <ToastCountdown toast={toastItem} />
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
};

/**
 * A faint line along the bottom edge that shrinks over the toast's lifetime
 * and holds still whenever Base UI holds the timer (hover, focus, blurred
 * window). Keyed on `updateKey`, so a refreshed toast starts it again.
 */
const ToastCountdown = ({
  toast,
}: {
  toast: {
    timeout?: number | undefined;
    type?: string | undefined;
    updateKey?: number | undefined;
  };
}) => {
  const countdownMs = toastCountdownMs(toast);
  if (countdownMs === undefined) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className="bg-foreground/10 animate-toast-countdown pointer-events-none absolute inset-x-3 bottom-1 h-0.5 rounded-full in-data-expanded:[animation-play-state:paused] in-data-window-blurred:[animation-play-state:paused] motion-reduce:hidden ltr:origin-left rtl:origin-right"
      data-slot="toast-countdown"
      key={toast.updateKey ?? 0}
      style={{ animationDuration: `${String(countdownMs)}ms` }}
    />
  );
};

const AnchoredToastProvider = ({
  children,
  ...props
}: Toast.Provider.Props) => (
  <Toast.Provider toastManager={anchoredToastManager} {...props}>
    {children}
    <AnchoredToasts />
  </Toast.Provider>
);

const AnchoredToasts = () => {
  const { toasts } = Toast.useToastManager<{ tooltipStyle?: boolean }>();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport
        className="outline-none"
        data-slot="toast-viewport-anchored"
      >
        {toasts.map((toastItem) => {
          const tooltipStyle = toastItem.data?.tooltipStyle ?? false;
          const positionerProps = toastItem.positionerProps;

          if (!positionerProps?.anchor) {
            return null;
          }

          return (
            <Toast.Positioner
              className="z-50 max-w-[min(--spacing(64),var(--available-width))]"
              data-slot="toast-positioner"
              key={toastItem.id}
              sideOffset={positionerProps.sideOffset ?? 4}
              toast={toastItem}
            >
              <Toast.Root
                className={cn(
                  "bg-popover text-popover-foreground relative border text-xs text-balance transition-[scale,opacity] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                  tooltipStyle
                    ? "rounded-md shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]"
                    : "rounded-lg shadow-lg/5 before:rounded-[calc(var(--radius-lg)-1px)]",
                )}
                data-slot="toast-popup"
                toast={toastItem}
              >
                {tooltipStyle ? (
                  <Toast.Content className="pointer-events-auto px-2 py-1 select-text">
                    <ScrollArea
                      axis="vertical"
                      className="h-auto [&_[data-slot=scroll-area-viewport]]:max-h-[60dvh]"
                    >
                      <Toast.Title
                        className="wrap-anywhere whitespace-pre-wrap"
                        data-slot="toast-title"
                      />
                    </ScrollArea>
                  </Toast.Content>
                ) : (
                  <Toast.Content className="pointer-events-auto flex items-center gap-3 px-3.5 py-3 text-sm select-text">
                    <div className="flex min-w-0 flex-1 gap-2">
                      <ToastIcon type={toastItem.type} />

                      <ScrollArea
                        axis="vertical"
                        className="h-auto min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]]:max-h-[60dvh]"
                      >
                        <div className="flex min-w-0 flex-col gap-0.5 select-text">
                          <Toast.Title
                            className="font-medium wrap-anywhere whitespace-pre-wrap"
                            data-slot="toast-title"
                          />
                          <Toast.Description
                            className="text-muted-foreground wrap-anywhere whitespace-pre-wrap"
                            data-slot="toast-description"
                          />
                        </div>
                      </ScrollArea>
                    </div>
                    {toastItem.actionProps && (
                      <Toast.Action
                        className={cn(
                          buttonVariants({ size: "xs" }),
                          "ms-auto shrink-0 select-none",
                        )}
                        data-slot="toast-action"
                      >
                        {toastItem.actionProps.children}
                      </Toast.Action>
                    )}
                  </Toast.Content>
                )}
              </Toast.Root>
            </Toast.Positioner>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
};

function addToast(
  title: React.ReactNode,
  type: ToastType | undefined,
  options?: ToastOptions,
) {
  const addOptions = { ...options, title, type };
  return toastManager.add(
    normalizeToastAddOptions({
      ...addOptions,
      id: addOptions.id ?? toastDedupeId(addOptions),
    }),
  );
}

/**
 * The same message raised again refreshes the toast already on screen (and
 * restarts its timer) instead of stacking a copy. Only plain-text messages
 * without an action merge: an action belongs to the call that raised it, and
 * a loading toast is owned by the promise that will settle it.
 */
function toastDedupeId({
  action,
  actionProps,
  description,
  title,
  type,
}: Pick<
  ToastAddOptions,
  "action" | "actionProps" | "description" | "title" | "type"
>): string | undefined {
  if (
    type === "loading" ||
    action !== undefined ||
    actionProps !== undefined ||
    typeof title !== "string" ||
    (description !== undefined &&
      description !== null &&
      typeof description !== "string")
  ) {
    return undefined;
  }
  return `toast-dedupe:${JSON.stringify([type ?? "neutral", title, description ?? ""])}`;
}

/**
 * How long the countdown runs, or `undefined` when the toast stays until
 * dismissed (errors, loading, timeout 0).
 */
function toastCountdownMs({
  timeout,
  type,
}: {
  timeout?: number | undefined;
  type?: string | undefined;
}): number | undefined {
  return type === "loading" || timeout === undefined || timeout <= 0
    ? undefined
    : timeout;
}

// Base UI pauses toast timers while the window is blurred; the countdown bar
// pauses with them. The viewport's hover and focus pause shows as
// `data-expanded` on each toast.
const subscribeWindowFocus = (onChange: () => void) => {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
};
const readWindowFocus = () => document.hasFocus();
const readServerWindowFocus = () => true;

function normalizeToastAddOptions(options: ToastUpdateOptions) {
  const { action, actionProps, timeout, type, ...addOptions } = options;
  return {
    ...addOptions,
    ...normalizeToastActionProps({ action, actionProps }),
    timeout: normalizeToastTimeout(timeout ?? getDefaultToastTimeout(options)),
    type,
  };
}

function normalizeToastUpdateOptions(options: ToastUpdateOptions) {
  const { action, actionProps, timeout, type, ...updateOptions } = options;
  const normalizedTimeout =
    timeout === undefined
      ? normalizeDefaultToastUpdateTimeout(options)
      : normalizeToastTimeout(timeout);

  return {
    ...updateOptions,
    ...normalizeToastActionProps({
      action,
      actionProps,
      includeEmptyActionProps:
        Object.hasOwn(options, "action") ||
        Object.hasOwn(options, "actionProps"),
    }),
    ...(type === undefined ? {} : { type }),
    ...(normalizedTimeout === undefined ? {} : { timeout: normalizedTimeout }),
  };
}

function normalizeDefaultToastUpdateTimeout(options: ToastUpdateOptions) {
  if (options.type === undefined) {
    return undefined;
  }

  return normalizeToastTimeout(getDefaultToastTimeout(options));
}

function normalizeToastActionProps({
  action,
  actionProps,
  includeEmptyActionProps = false,
}: {
  action: ToastAction | undefined;
  actionProps: ToastActionProps | undefined;
  includeEmptyActionProps?: boolean;
}) {
  if (action === undefined) {
    return actionProps === undefined && !includeEmptyActionProps
      ? {}
      : { actionProps };
  }

  return {
    actionProps: {
      ...actionProps,
      children: action.label,
      onClick: action.onClick,
    },
  };
}

/**
 * A short plain error closes on its own like any notice. An error that carries
 * detail (a description, rich content such as a provider reason to copy) or an
 * action stays until dismissed, so it is never gone before it can be read.
 */
function getDefaultToastTimeout({
  action,
  actionProps,
  description,
  title,
  type,
}: ToastUpdateOptions) {
  if (type === "loading") {
    return 0;
  }

  if (type === "error") {
    const plain =
      typeof title === "string" &&
      (description === undefined || description === null) &&
      action === undefined &&
      actionProps === undefined;
    return plain ? ERROR_TOAST_TIMEOUT_MS : 0;
  }

  if (type === "warning") {
    return 6000;
  }

  return 4000;
}

function normalizeToastTimeout(timeout: number | undefined) {
  if (timeout === Number.POSITIVE_INFINITY) {
    return 0;
  }

  return timeout;
}

function getPromiseToastTitle(
  option: ToastPromiseMessage,
): React.ReactNode | undefined {
  return isToastUpdateOptions(option) ? option.title : option;
}

function getPromiseToastOptions(
  option: ToastPromiseMessage,
): ToastUpdateOptions | undefined {
  return isToastUpdateOptions(option) ? option : undefined;
}

function getPromiseToastUpdateOptions<Value>(
  option: ToastPromiseMessage | ((value: Value) => ToastPromiseMessage),
  value: Value,
  type: ToastType,
) {
  const resolved = typeof option === "function" ? option(value) : option;

  if (isToastUpdateOptions(resolved)) {
    const hasReplacementAction =
      resolved.action !== undefined || Object.hasOwn(resolved, "actionProps");

    return {
      ...resolved,
      ...(hasReplacementAction ? {} : { actionProps: undefined }),
      type,
    };
  }

  return { actionProps: undefined, title: resolved, type };
}

function isToastUpdateOptions(
  value: ToastPromiseMessage,
): value is ToastUpdateOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (Array.isArray(value) || React.isValidElement(value)) {
    return false;
  }

  return !(Symbol.iterator in value);
}

const ToastIcon = ({ type }: { type: string | undefined }) => {
  if (type === "loading") {
    return (
      <Loader
        className="h-lh w-4 opacity-80"
        data-slot="toast-icon"
        size="sm"
        variant="decorative"
      />
    );
  }
  const icon = getToastIcon(type);
  if (icon === null) {
    return null;
  }
  return (
    <div
      className="select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>svg]:h-lh [&>svg]:w-4"
      data-slot="toast-icon"
    >
      {icon}
    </div>
  );
};

function getToastIcon(type: string | undefined) {
  if (!isToastType(type)) {
    return null;
  }

  return TOAST_ICONS[type];
}

function isToastType(type: string | undefined): type is ToastType {
  return typeof type === "string" && type in TOAST_ICONS;
}

export {
  ToastProvider,
  type ToastPosition,
  TOAST_RIGHT_OFFSET_VAR,
  stellaToast,
  AnchoredToastProvider,
  toastCountdownMs,
  toastDedupeId,
};
