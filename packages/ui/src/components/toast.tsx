"use client";

import * as React from "react";

import { Toast } from "@base-ui/react/toast";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { buttonVariants } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

type ToastData = {
  tooltipStyle?: boolean;
};

const toastManager = Toast.createToastManager<ToastData>();
const anchoredToastManager = Toast.createToastManager<ToastData>();

const TOAST_RIGHT_OFFSET_VAR = "--stella-toast-right-offset";

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  neutral: null,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
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
      toastManager.add(normalizeToastAddOptions(options)),
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

function ToastProvider({
  children,
  position = "bottom-right",
  ...props
}: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ToastData>();
  const isTop = position.startsWith("top");

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-[60] mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "md:data-[position*=right]:w-[calc(100%-var(--toast-inset)*2-min(var(--stella-toast-right-offset,0px),calc(100vw-var(--toast-inset)*2-10rem)))]",
          // Vertical positioning
          "data-[position*=top]:top-(--toast-inset)",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:start-(--toast-inset)",
          "data-[position*=right]:end-(--toast-inset)",
          "md:data-[position*=right]:end-[calc(var(--toast-inset)+min(var(--stella-toast-right-offset,0px),calc(100vw-var(--toast-inset)*2-10rem)))]",
          "data-[position*=center]:left-1/2 data-[position*=center]:-translate-x-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
      >
        {toasts.map((toastItem) => {
          const Icon = getToastIcon(toastItem.type);

          return (
            <Toast.Root
              className={cn(
                "bg-popover text-popover-foreground absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full rounded-lg border shadow-lg/5 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
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
              <Toast.Content className="pointer-events-auto flex items-center gap-3 overflow-hidden px-3.5 py-3 text-sm transition-opacity duration-250 select-text data-behind:opacity-0 data-behind:not-data-expanded:pointer-events-none data-expanded:opacity-100">
                <div className="flex min-w-0 flex-1 gap-2">
                  {Icon && (
                    <div
                      className="select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>svg]:h-lh [&>svg]:w-4"
                      data-slot="toast-icon"
                    >
                      <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:animate-spin in-data-[type=loading]:opacity-80" />
                    </div>
                  )}

                  <div className="flex min-w-0 flex-col gap-0.5 select-text">
                    <Toast.Title
                      className="truncate font-medium"
                      data-slot="toast-title"
                    />
                    <Toast.Description
                      className="text-muted-foreground break-words"
                      data-slot="toast-description"
                    />
                  </div>
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
                    className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded p-0.5 transition-colors select-none"
                    data-slot="toast-close"
                    aria-label="Close notification"
                  >
                    <XIcon className="size-4" />
                  </Toast.Close>
                </div>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<{ tooltipStyle?: boolean }>();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport
        className="outline-none"
        data-slot="toast-viewport-anchored"
      >
        {toasts.map((toastItem) => {
          const Icon = getToastIcon(toastItem.type);
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
                    <Toast.Title data-slot="toast-title" />
                  </Toast.Content>
                ) : (
                  <Toast.Content className="pointer-events-auto flex items-center gap-3 overflow-hidden px-3.5 py-3 text-sm select-text">
                    <div className="flex min-w-0 flex-1 gap-2">
                      {Icon && (
                        <div
                          className="select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>svg]:h-lh [&>svg]:w-4"
                          data-slot="toast-icon"
                        >
                          <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:animate-spin in-data-[type=loading]:opacity-80" />
                        </div>
                      )}

                      <div className="flex min-w-0 flex-col gap-0.5 select-text">
                        <Toast.Title
                          className="truncate font-medium"
                          data-slot="toast-title"
                        />
                        <Toast.Description
                          className="text-muted-foreground break-words"
                          data-slot="toast-description"
                        />
                      </div>
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
}

function addToast(
  title: React.ReactNode,
  type: ToastType | undefined,
  options?: ToastOptions,
) {
  return toastManager.add(
    normalizeToastAddOptions({
      ...options,
      title,
      type,
    }),
  );
}

function normalizeToastAddOptions({
  action,
  actionProps,
  timeout,
  type,
  ...options
}: ToastUpdateOptions) {
  return {
    ...options,
    ...normalizeToastActionProps({ action, actionProps }),
    timeout: normalizeToastTimeout(timeout ?? getDefaultToastTimeout(type)),
    type,
  };
}

function normalizeToastUpdateOptions(options: ToastUpdateOptions) {
  const { action, actionProps, timeout, type, ...updateOptions } = options;
  const normalizedTimeout =
    timeout === undefined
      ? normalizeDefaultToastUpdateTimeout(type)
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

function normalizeDefaultToastUpdateTimeout(type: ToastType | undefined) {
  if (type === undefined) {
    return undefined;
  }

  return normalizeToastTimeout(getDefaultToastTimeout(type));
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

function getDefaultToastTimeout(type: ToastType | undefined) {
  if (type === "loading") {
    return 0;
  }

  if (type === "error" || type === "warning") {
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
};
