/**
 * Swappable text-measurement seam.
 *
 * Holds the provider interface, the active-provider registry, and the four
 * public delegators the layout engine measures through. This module is pure:
 * it never imports the canvas backend, so the engine's import graph stays
 * canvas-free. The default provider throws — a composition root must install a
 * concrete backend first (the React editor and the bun test preload call
 * `installCanvasMeasureProvider()`).
 */

import { panic } from "better-result";

import type {
  FontMetrics,
  FontStyle,
  RunMeasurement,
  TextMeasurement,
} from "./measureTypes";

/**
 * Swappable text-measurement backend. A canvas implementation is installed at
 * the composition roots; a Rust/WASM or headless provider can be installed via
 * `setMeasureProvider` without the layout engine importing canvas directly.
 */
export type MeasureProvider = {
  getFontMetrics: (style: FontStyle) => FontMetrics;
  measureTextWidth: (text: string, style: FontStyle) => number;
  measureText: (text: string, style: FontStyle) => TextMeasurement;
  measureRun: (text: string, style: FontStyle) => RunMeasurement;
};

const throwingMeasureProvider: MeasureProvider = {
  getFontMetrics: () => noProvider(),
  measureTextWidth: () => noProvider(),
  measureText: () => noProvider(),
  measureRun: () => noProvider(),
};

function noProvider(): never {
  panic(
    "No MeasureProvider installed — install canvasMeasureProvider " +
      "(the React editor and the test preload do this).",
  );
}

let activeMeasureProvider: MeasureProvider = throwingMeasureProvider;

export const getMeasureProvider = (): MeasureProvider => activeMeasureProvider;

export const setMeasureProvider = (provider: MeasureProvider): void => {
  activeMeasureProvider = provider;
};

export const resetMeasureProvider = (): void => {
  activeMeasureProvider = throwingMeasureProvider;
};

export const getFontMetrics = (style: FontStyle): FontMetrics =>
  activeMeasureProvider.getFontMetrics(style);

export const measureTextWidth = (text: string, style: FontStyle): number =>
  activeMeasureProvider.measureTextWidth(text, style);

export const measureText = (text: string, style: FontStyle): TextMeasurement =>
  activeMeasureProvider.measureText(text, style);

export const measureRun = (text: string, style: FontStyle): RunMeasurement =>
  activeMeasureProvider.measureRun(text, style);
