import { panic } from "better-result";

type HydrationBootBase = {
  hydrate: () => Promise<void>;
  initializeClientState: () => Promise<unknown>;
};

export type HydrationBootOptions =
  | (HydrationBootBase & {
      type: "client-rendered";
    })
  | (HydrationBootBase & {
      type: "server-rendered";
    });

export const bootHydratedClient = async (
  options: HydrationBootOptions,
): Promise<unknown> => {
  switch (options.type) {
    case "client-rendered": {
      try {
        return await options.initializeClientState();
      } finally {
        await options.hydrate();
      }
    }
    case "server-rendered":
      await options.hydrate();
      return await options.initializeClientState();
    default: {
      options satisfies never;
      return panic(`Unhandled options: ${String(options)}`);
    }
  }
};
