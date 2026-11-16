import { devices } from "./devices.gen";

export { devices };

export const isDevicePresetName = (
  name: string,
): name is keyof typeof devices => Object.hasOwn(devices, name);
