import { FileTextIcon } from "@stll/ui/icons";
import { ReviewCommentCard } from "@stll/ui/review-comment-card";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
} from "@stll/ui/review-diff-text";
import { TextMark } from "@stll/ui/text-mark";

import { formatPreviewCount, formatPreviewTime } from "./format";
import { PREVIEW_PEOPLE } from "./mock-data";
import { FeaturePreviewSurface, PreviewAvatarStack } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type DocumentsPreviewLabels = {
  /** Heading of the comment rail beside the page. */
  comments: string;
};

/** A Word document edited in place: a page with a tracked change and a
 *  commented passage, and the comment rail beside it. */
export const DocumentsPreview = ({
  labels,
  locale,
  className,
}: FeaturePreviewProps<DocumentsPreviewLabels>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<FileTextIcon className="text-info size-4 shrink-0" />}
    meta={
      <PreviewAvatarStack
        people={[PREVIEW_PEOPLE.laura, PREVIEW_PEOPLE.amira]}
      />
    }
    title={DOCUMENT_NAME}
  >
    <div className="flex h-full min-h-0">
      <div className="bg-muted/50 flex min-w-0 flex-1 justify-center overflow-hidden px-4 pt-4">
        {/* Document surfaces keep an LTR base even under an RTL interface. */}
        <article
          className="bg-card text-foreground text-2xs flex w-full max-w-md flex-col gap-2.5 rounded-t-sm border border-b-0 px-6 pt-6 font-serif leading-relaxed shadow-sm"
          dir="ltr"
        >
          <h3 className="text-center text-xs font-semibold tracking-widest">
            SHARE PURCHASE AGREEMENT
          </h3>
          <p className="font-semibold">4. Purchase price</p>
          <p>
            4.1 The Purchase Price shall be EUR 4,200,000, payable to the
            Seller&apos;s account within{" "}
            <ReviewDiffDeletion>30</ReviewDiffDeletion>
            <ReviewDiffInsertion>45</ReviewDiffInsertion> Business Days of
            Completion.
          </p>
          <p>
            4.2 An amount equal to 10% of the Purchase Price shall be held in
            escrow{" "}
            <TextMark tone="option-yellow" variant="fill">
              until the expiry of the Warranty Period
            </TextMark>{" "}
            in accordance with Schedule 6.
          </p>
          <p className="font-semibold">5. Warranties</p>
          <p>
            5.1 The Seller warrants to the Buyer that each of the Warranties is
            true, accurate and not misleading at the date of this Agreement and
            will be so at Completion.
          </p>
          <p>
            5.2 Each Warranty is a separate and independent warranty and shall
            not be limited by reference to any other Warranty.
          </p>
        </article>
      </div>
      <aside className="flex w-[38%] max-w-64 min-w-0 shrink-0 flex-col border-s">
        <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-1.5 px-3 font-medium">
          {labels.comments}
          <span className="tabular-nums">
            {formatPreviewCount(locale, COMMENTS.length)}
          </span>
        </div>
        {COMMENTS.map((comment) => (
          <ReviewCommentCard
            anchorText={comment.anchor}
            author={comment.author}
            body={comment.body}
            className="border-t"
            formattedTime={formatPreviewTime(locale, comment.time)}
            key={comment.time}
            timestamp={`2026-10-19T${comment.time}:00Z`}
          />
        ))}
      </aside>
    </div>
  </FeaturePreviewSurface>
);

// Mock content depicting user data, not interface text; deliberately
// untranslated.
const DOCUMENT_NAME = "Share Purchase Agreement.docx";

const COMMENTS = [
  {
    author: PREVIEW_PEOPLE.laura,
    time: "09:12",
    anchor: "45 Business Days",
    body: "Buyer's counsel will push for 60 days. 45 is our floor.",
  },
  {
    author: PREVIEW_PEOPLE.amira,
    time: "10:47",
    anchor: "until the expiry of the Warranty Period",
    body: "Tie the escrow release to the claims deadline in clause 7.3.",
  },
] as const;
