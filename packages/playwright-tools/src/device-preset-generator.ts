import { devices } from "@playwright/test";

export const playwrightDevicePreset = (name: string) => {
  for (const [presetName, preset] of Object.entries(devices)) {
    if (presetName === name) {
      return preset;
    }
  }
  return undefined;
};
