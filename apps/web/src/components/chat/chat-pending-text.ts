/**
 * The sweep across a label whose work is still running: a running tool row,
 * the thinking indicator, a reasoning trace still streaming. One class so
 * every live label in the thread moves in step; under reduced motion it
 * holds still as muted text, and in RTL it sweeps toward the reader.
 */
export const CHAT_PENDING_TEXT_CLASS =
  "animate-skeleton motion-reduce:text-muted-foreground bg-[linear-gradient(90deg,var(--color-foreground-ghost)_35%,var(--color-muted-foreground)_50%,var(--color-foreground-ghost)_65%)] bg-[length:250%_100%] bg-clip-text text-transparent motion-reduce:animate-none rtl:[animation-name:skeleton-rtl]";
