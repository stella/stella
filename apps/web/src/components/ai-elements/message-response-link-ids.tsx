import { createContext, use, useMemo } from "react";
import type { ComponentType, JSX, ReactNode } from "react";

import { Block } from "streamdown";
import type { BlockProps, ExtraProps } from "streamdown";

import { ChatLinkIdScope } from "@stll/chat/link";

import { answerLinkOrdinal } from "@/components/chat/rehype-number-answer-links";
import { ANSWER_ID_PREFIX } from "@/components/chat/rehype-scope-answer-ids";

/**
 * Link ids inside a rendered answer. React's generated ids count every mount
 * on the page, so a streamed answer and the same answer after a reload would
 * name their links differently. An answer link's ids come from where it sits
 * instead: the parsed tree it belongs to (a block while the answer streams,
 * the whole answer once it settles) and its place among that tree's links
 * (`rehypeNumberAnswerLinks`).
 *
 * A tree is named by its index and a tag of its text. The index keeps
 * repeated identical blocks of one answer apart; the tag keeps two answers on
 * a page apart unless they share a block at the same index, and then the
 * links it names carry the same hints. Ids stay in the answer namespace, like
 * footnote ids.
 */

const TAG_BASE = 257;
const TAG_MODULUS = 2_147_483_647;

/** A short, stable tag of a tree's text (a polynomial hash, base 36). */
const textTag = (text: string): string => {
  let hash = 0;
  for (const character of text) {
    hash = (hash * TAG_BASE + (character.codePointAt(0) ?? 0)) % TAG_MODULUS;
  }
  return hash.toString(36);
};

export const answerTreeIdPrefix = (index: number, text: string): string =>
  `${ANSWER_ID_PREFIX}link-${textTag(text)}-${index}`;

const AnswerTreeContext = createContext<string | undefined>(undefined);

/** Names the links of a tree rendered outside Streamdown's blocks. */
export const AnswerTreeIds = ({
  children,
  prefix,
}: {
  children: ReactNode;
  prefix: string | undefined;
}) => <AnswerTreeContext value={prefix}>{children}</AnswerTreeContext>;

/** Streamdown's block, naming the links of the block it renders. */
export const AnswerBlock = (props: BlockProps) => {
  const prefix = useMemo(
    () => answerTreeIdPrefix(props.index, props.content),
    [props.index, props.content],
  );
  return (
    <AnswerTreeContext value={prefix}>
      <Block {...props} />
    </AnswerTreeContext>
  );
};

type AnswerLinkComponent = ComponentType<
  JSX.IntrinsicElements["a"] & ExtraProps
>;

const scopedLinks = new WeakMap<AnswerLinkComponent, AnswerLinkComponent>();

/**
 * The answer's link renderer, giving each link it renders the ids of its
 * place. One wrapper per renderer, so the component keeps its identity across
 * renders.
 */
export const withAnswerLinkIds = (
  Link: AnswerLinkComponent,
): AnswerLinkComponent => {
  const known = scopedLinks.get(Link);
  if (known !== undefined) {
    return known;
  }
  const AnswerLink = (props: JSX.IntrinsicElements["a"] & ExtraProps) => {
    const prefix = use(AnswerTreeContext);
    const ordinal = answerLinkOrdinal(props.node);
    if (prefix === undefined || ordinal === undefined) {
      return <Link {...props} />;
    }
    return (
      <ChatLinkIdScope id={`${prefix}-${ordinal}`}>
        <Link {...props} />
      </ChatLinkIdScope>
    );
  };
  scopedLinks.set(Link, AnswerLink);
  return AnswerLink;
};
