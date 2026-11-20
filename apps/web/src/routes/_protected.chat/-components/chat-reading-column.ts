/**
 * The one measure a chat thread is read in: 46rem of text, centred. The
 * transcript, its banners, the bottom fade and the composer all take it from
 * here, so every block of the thread shares the same start and end edges and
 * no surface draws a second, narrower right edge inside it.
 */
export const CHAT_READING_COLUMN_CLASS_NAME = "mx-auto w-full max-w-3xl px-4";

/**
 * The composer's row of the same column. Its tray pads the composer box by
 * `p-2`, so the row pads by the rest, and the box lands on the text's edges.
 */
export const CHAT_COMPOSER_COLUMN_CLASS_NAME = "mx-auto w-full max-w-3xl px-2";
