import type {
  HandlerConfig,
  PublicHandlerConfig,
  SessionHandlerConfig,
  TokenHandlerConfig,
  WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";

import type { WriteContract } from "./write-contract";

type HasRequiredContract<T> = [T] extends [WriteContract] ? true : never;

export const handlerRequiresContract: HasRequiredContract<HandlerConfig> = true;
export const workspaceRequiresContract: HasRequiredContract<WorkspaceHandlerConfig> = true;
export const publicRequiresContract: HasRequiredContract<PublicHandlerConfig> = true;
export const sessionRequiresContract: HasRequiredContract<SessionHandlerConfig> = true;
export const tokenRequiresContract: HasRequiredContract<TokenHandlerConfig> = true;

// @ts-expect-error A config without a discriminator cannot reach a safe factory.
export const missingContract: WriteContract = {};

// @ts-expect-error A replacement must declare its precondition protocol.
export const missingPrecondition: WriteContract = { contract: "replace" };

export const plantedDebt: WriteContract = {
  contract: "replace",
  precondition: {
    type: "deferred",
    // @ts-expect-error New replacement identities cannot use migration debt.
    baselineId: "apps/api/src/handlers/planted/update.ts",
  },
};
