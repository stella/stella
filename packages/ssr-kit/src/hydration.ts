import { panic } from "better-result";

type ScheduleAfterPaint = () => Promise<void>;

type HydrationBootBase = {
  hydrate: () => void;
  initializeClientState: () => Promise<unknown>;
};

export type HydrationBootOptions =
  | (HydrationBootBase & {
      type: "client-rendered";
    })
  | (HydrationBootBase & {
      type: "server-rendered";
      scheduleAfterPaint?: ScheduleAfterPaint | undefined;
    });

const defaultScheduleAfterPaint: ScheduleAfterPaint = async () => {
  await new Promise<void>((resolve) => {
    globalThis.requestAnimationFrame(() => {
      globalThis.setTimeout(() => {
        resolve();
      }, 0);
    });
  });
};

export const bootHydratedClient = async (
  options: HydrationBootOptions,
): Promise<unknown> => {
  switch (options.type) {
    case "client-rendered":
      return await options.initializeClientState().finally(options.hydrate);
    case "server-rendered":
      options.hydrate();
      await (options.scheduleAfterPaint ?? defaultScheduleAfterPaint)();
      return await options.initializeClientState();
    default: {
      options satisfies never;
      return panic(`Unhandled options: ${String(options)}`);
    }
  }
};
