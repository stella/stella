/**
 * A suggestion piece's one-line label: the matter, then the piece's own time.
 * The time never shrinks, so a narrow piece ellipsises the matter and keeps
 * "15:40–15:56 · 16 min" whole; a piece too narrow for that drops the range
 * and keeps the minutes. The day calendar's block is a size container, which
 * the range's width query reads.
 */
export const SuggestionPieceLabel = ({
  duration,
  matter,
  range,
}: {
  duration: string;
  matter: string;
  range: string;
}) => (
  <span className="flex min-w-0 items-center" data-suggestion-piece-label="">
    <bdi className="min-w-0 truncate" data-part="matter">
      {matter}
    </bdi>
    <span className="shrink-0 whitespace-nowrap tabular-nums" data-part="time">
      {LEADING_SEPARATOR}
      <span className="@max-[120px]:hidden" data-part="range">
        <bdi>{range}</bdi>
        {PART_SEPARATOR}
      </span>
      <span data-part="duration">{duration}</span>
    </span>
  </span>
);

/** Joins the parts as the Activity column joins a block's label parts. */
const PART_SEPARATOR = " · ";
/** The same, opening the time segment: a flex item drops a plain leading
 * space. */
const LEADING_SEPARATOR = "\u00A0· ";
