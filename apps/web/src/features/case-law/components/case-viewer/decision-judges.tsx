import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { ReviewAuthorAvatar } from "@stll/ui/review-author-avatar";

import {
  DECISION_JUDGE_ROLE_LABELS,
  decisionBenchSeats,
  portraitAttributions,
} from "@/features/case-law/decision-judges";
import type {
  DecisionBenchSeat,
  DecisionJudge,
} from "@/features/case-law/decision-judges";
import { browserApiRootUrl } from "@/lib/api-origins";

/**
 * The bench of a decision: who sat, who reported it and who wrote
 * separately, one tile per person captioned with each part they played, with
 * the face the court publishes where there is one. A judge the roster holds
 * no portrait for keeps their initials rather than a dimmed placeholder — the
 * roster not knowing a face says nothing about the judge.
 *
 * The row wraps, so a pane at a phone's width stacks the bench instead of
 * clipping it.
 */
export const DecisionJudges = ({
  judges,
}: {
  judges: readonly DecisionJudge[];
}) => {
  const t = useTranslations();
  const credits = portraitAttributions(judges);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap items-start gap-x-3 gap-y-3">
        {decisionBenchSeats(judges).map((seat) => (
          <li
            className="flex w-20 flex-col items-center gap-1 text-center"
            key={seat.key}
          >
            <JudgePortrait seat={seat} />
            <BidiText
              as="span"
              className="text-foreground-strong-muted leading-tight font-medium"
            >
              {seat.name}
            </BidiText>
            {seat.roles.map((role) => (
              <span
                className="text-foreground-disabled text-2xs leading-tight"
                key={role}
              >
                {t(DECISION_JUDGE_ROLE_LABELS[role])}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {credits.length > 0 && (
        <p className="text-foreground-disabled text-2xs leading-tight">
          {t("caseLaw.viewer.portraitCredit", { source: credits.join(", ") })}
        </p>
      )}
    </div>
  );
};

/**
 * One slash and then something that is not a slash: an API-root-relative
 * path. `//host/x` and `/\host/x` are network-path references that resolve
 * against the scheme rather than the API root, so they are not addresses of
 * this API and never reach the URL helper.
 */
const API_ROOT_RELATIVE_PATH = /^\/(?![/\\])/u;

/**
 * Where the browser fetches one portrait from.
 *
 * The read hands over a path relative to the API root with the version
 * prefix already on it, so it is composed with `browserApiRootUrl` rather
 * than `apiUrl`, which would prepend `/v1` a second time. The leading slash
 * is rebuilt because that is the shape the helper takes; a read that lost it
 * is an API defect, not a portrait with a different address.
 */
export const judgePortraitSrc = (path: string): string =>
  API_ROOT_RELATIVE_PATH.test(path)
    ? browserApiRootUrl(`/${path.slice(1)}`)
    : panic(`Judge portrait path is not API-root-relative: ${path}`);

/**
 * The design system's avatar, not `UserIdentityAvatar`: a judge is the
 * court's, not an account of this workspace, so the identity the app binds
 * to a user must not be reused for one. The renderer is shared, which is
 * what keeps the initials fallback from being rebuilt here.
 */
const JudgePortrait = ({ seat }: { seat: DecisionBenchSeat }) => (
  <ReviewAuthorAvatar
    className="size-9"
    image={seat.portrait === null ? null : judgePortraitSrc(seat.portrait.url)}
    name={seat.name}
  />
);
