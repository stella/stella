import { FileTextIcon } from "@stll/ui/icons";
import { ReviewCommentCard } from "@stll/ui/review-comment-card";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
} from "@stll/ui/review-diff-text";
import { TextMark } from "@stll/ui/text-mark";

import { formatPreviewCount, formatPreviewTime } from "./format";
import { PREVIEW_PEOPLE } from "./mock-data";
import type { PreviewPerson } from "./mock-data";
import { FeaturePreviewSurface, PreviewAvatarStack } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type DocumentsPreviewLabels = {
  /** Heading of the comment rail beside the page. */
  comments: string;
};

export type DocumentsPreviewComment = {
  author: PreviewPerson;
  /** `HH:MM`; unique within the document. */
  time: string;
  /** The commented passage, quoted under the comment. */
  anchor: string;
  body: string;
};

/** The page's content, top to bottom: a title, a heading, a clause with one
 *  tracked change (`deleted` replaced by `inserted`), a clause with a
 *  commented passage (`marked`), another heading and plain clauses; then
 *  the comment rail. Text is literal: number each clause in its text. */
export type DocumentsPreviewData = {
  fileName: string;
  /** People shown in the title row. */
  reviewers: readonly PreviewPerson[];
  title: string;
  heading: string;
  trackedChange: {
    before: string;
    deleted: string;
    inserted: string;
    after: string;
  };
  commented: { before: string; marked: string; after: string };
  nextHeading: string;
  clauses: readonly string[];
  comments: readonly DocumentsPreviewComment[];
};

/** A Word document edited in place: a page with a tracked change and a
 *  commented passage, and the comment rail beside it. */
export const DocumentsPreview = ({
  labels,
  locale,
  data = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<DocumentsPreviewLabels, DocumentsPreviewData>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<FileTextIcon className="text-info size-4 shrink-0" />}
    meta={<PreviewAvatarStack people={data.reviewers} />}
    title={data.fileName}
  >
    <div className="flex h-full min-h-0">
      <div className="bg-muted/50 flex min-w-0 flex-1 justify-center overflow-hidden px-4 pt-4">
        {/* Document surfaces keep an LTR base even under an RTL interface. */}
        <article
          className="bg-card text-foreground text-2xs flex w-full max-w-md flex-col gap-2.5 rounded-t-sm border border-b-0 px-6 pt-6 font-serif leading-relaxed shadow-sm"
          dir="ltr"
        >
          <h3 className="text-center text-xs font-semibold tracking-widest">
            {data.title}
          </h3>
          <p className="font-semibold">{data.heading}</p>
          <p>
            {data.trackedChange.before}
            <ReviewDiffDeletion>
              {data.trackedChange.deleted}
            </ReviewDiffDeletion>
            <ReviewDiffInsertion>
              {data.trackedChange.inserted}
            </ReviewDiffInsertion>
            {data.trackedChange.after}
          </p>
          <p>
            {data.commented.before}
            <TextMark tone="option-yellow" variant="fill">
              {data.commented.marked}
            </TextMark>
            {data.commented.after}
          </p>
          <p className="font-semibold">{data.nextHeading}</p>
          {data.clauses.map((clause) => (
            <p key={clause}>{clause}</p>
          ))}
        </article>
      </div>
      <aside className="flex w-[38%] max-w-64 min-w-0 shrink-0 flex-col border-s">
        <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-1.5 px-3 font-medium">
          {labels.comments}
          <span className="tabular-nums">
            {formatPreviewCount(locale, data.comments.length)}
          </span>
        </div>
        {data.comments.map((comment) => (
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

// The default content; see `mock-data.ts`.
const DEFAULT_DATA = {
  fileName: "Share Purchase Agreement.docx",
  reviewers: [PREVIEW_PEOPLE.laura, PREVIEW_PEOPLE.amira],
  title: "SHARE PURCHASE AGREEMENT",
  heading: "4. Purchase price",
  trackedChange: {
    before:
      "4.1 The Purchase Price shall be EUR 4,200,000, payable to the Seller's account within ",
    deleted: "30",
    inserted: "45",
    after: " Business Days of Completion.",
  },
  commented: {
    before:
      "4.2 An amount equal to 10% of the Purchase Price shall be held in escrow ",
    marked: "until the expiry of the Warranty Period",
    after: " in accordance with Schedule 6.",
  },
  nextHeading: "5. Warranties",
  clauses: [
    "5.1 The Seller warrants to the Buyer that each of the Warranties is true, accurate and not misleading at the date of this Agreement and will be so at Completion.",
    "5.2 Each Warranty is a separate and independent warranty and shall not be limited by reference to any other Warranty.",
  ],
  comments: [
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
  ],
} as const satisfies DocumentsPreviewData;
