import { captureBrowserError } from "./capture-source";

declare global {
  // oxlint-disable-next-line consistent-type-definitions -- global Window augmentation requires interface declaration merging
  interface Window {
    captureBrowserError: typeof captureBrowserError;
  }
}

window.captureBrowserError = captureBrowserError;
