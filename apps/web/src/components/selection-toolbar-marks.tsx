import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_STYLES,
} from "@stll/api-contract/legal-reader-annotations";
import type {
  ReaderAnnotationColor,
  ReaderAnnotationStyle,
  ReaderAnnotationVisibility,
} from "@stll/api-contract/legal-reader-annotations";
import { Button } from "@stll/ui/button";
import {
  Building2Icon,
  HighlighterIcon,
  LockIcon,
  StrikethroughIcon,
  UnderlineIcon,
  WavesIcon,
} from "@stll/ui/icons";

import Tooltip from "@/components/tooltip";

/**
 * The marking half of a selection bar: the highlight colours, the ways a
 * highlight is drawn, and who sees a mark. The case-law reader and the matter
 * PDF viewer draw the same controls, so a reader meets one palette and one
 * set of labels wherever words can be marked.
 */

const STYLE_ICONS = {
  highlight: HighlighterIcon,
  underline: UnderlineIcon,
  squiggly: WavesIcon,
  strikethrough: StrikethroughIcon,
} as const satisfies Record<ReaderAnnotationStyle, unknown>;

const markColorLabelKey = (color: ReaderAnnotationColor) => {
  switch (color) {
    case "yellow": {
      return "legalReader.annotations.colorYellow" as const;
    }
    case "green": {
      return "legalReader.annotations.colorGreen" as const;
    }
    case "sky": {
      return "legalReader.annotations.colorSky" as const;
    }
    case "violet": {
      return "legalReader.annotations.colorViolet" as const;
    }
    case "red": {
      return "legalReader.annotations.colorRed" as const;
    }
    default: {
      color satisfies never;
      return panic(`Unhandled color: ${String(color)}`);
    }
  }
};

const styleLabelKey = (style: ReaderAnnotationStyle) => {
  switch (style) {
    case "highlight": {
      return "legalReader.annotations.styleHighlight" as const;
    }
    case "underline": {
      return "folio.underline" as const;
    }
    case "squiggly": {
      return "legalReader.annotations.styleSquiggly" as const;
    }
    case "strikethrough": {
      return "legalReader.annotations.styleStrikethrough" as const;
    }
    default: {
      style satisfies never;
      return panic(`Unhandled style: ${String(style)}`);
    }
  }
};

/** One swatch per highlight colour; picking one marks in it. */
export const MarkColorSwatches = ({
  onPick,
}: {
  onPick: (color: ReaderAnnotationColor) => void;
}) => {
  const t = useTranslations();
  return READER_ANNOTATION_COLORS.map((color) => (
    <Tooltip
      content={t(markColorLabelKey(color))}
      key={color}
      render={
        <Button
          aria-label={t(markColorLabelKey(color))}
          className="group/act flex"
          onClick={() => onPick(color)}
          shape="round"
          variant="plain"
        >
          <span
            className="block size-4 rounded-full transition-transform group-hover/act:scale-110"
            style={{ backgroundColor: `var(--option-${color})` }}
          />
        </Button>
      }
    />
  ));
};

/** One toggle per way a highlight is drawn, the current one pressed. */
export const MarkStyleButtons = ({
  current,
  onPick,
}: {
  current: ReaderAnnotationStyle;
  onPick: (style: ReaderAnnotationStyle) => void;
}) => {
  const t = useTranslations();
  return READER_ANNOTATION_STYLES.map((option) => {
    const Icon = STYLE_ICONS[option];
    return (
      <Tooltip
        content={t(styleLabelKey(option))}
        key={option}
        render={
          <Button
            aria-label={t(styleLabelKey(option))}
            aria-pressed={current === option}
            // The ghost variant draws its pressed state from `data-pressed`.
            {...(current === option ? { "data-pressed": "" } : {})}
            onClick={() => onPick(option)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </Tooltip>
    );
  });
};

/**
 * Private to its author, or shared with everyone who can open the text: the
 * organization for a public-law document, the matter for a matter's own.
 */
export const MarkVisibilityToggle = ({
  onChange,
  sharedLabel,
  value,
}: {
  onChange: (next: ReaderAnnotationVisibility) => void;
  /** Who a shared mark is shown to, as the surface names them. */
  sharedLabel: string;
  value: ReaderAnnotationVisibility;
}) => {
  const t = useTranslations();
  const shared = value === "shared";
  const label = shared ? sharedLabel : t("knowledge.agentSkills.scopePrivate");

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          aria-pressed={shared}
          onClick={() => onChange(shared ? "private" : "shared")}
          size="xs"
          variant="ghost"
        />
      }
    >
      {shared ? (
        <Building2Icon className="size-3.5" />
      ) : (
        <LockIcon className="size-3.5" />
      )}
      <span className="text-2xs">{label}</span>
    </Tooltip>
  );
};
