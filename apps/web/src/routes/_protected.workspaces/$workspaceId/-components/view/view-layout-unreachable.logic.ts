import { panic } from "better-result";

/**
 * The end of a switch over every view layout: a layout no case names is a
 * state nobody handled, so it reaches the error boundary instead of drawing
 * nothing.
 */
export const unreachableViewLayout = (layout: never): never =>
  panic(`Unhandled view layout: ${JSON.stringify(layout)}`);
