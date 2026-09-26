import { isLocalDevOpen } from "@/api/runtime-mode";

export const documentScoutsEnabled = (featureEnabled: boolean): boolean =>
  isLocalDevOpen() || featureEnabled;
