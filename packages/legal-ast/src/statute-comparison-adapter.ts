import type { Result } from "better-result";

/** Word diff produced by the host's document comparison library. */
export type StatuteWordDiffSegment = {
  type: "equal" | "del" | "ins";
  text: string;
};

/** A block passed to the host's block alignment implementation. */
export type StatuteComparisonBlock = {
  id: string;
  kind: "heading" | "paragraph";
  text: string;
  idStability: "positional";
  statedNumbering: { kind: "inherit" };
  headingLevel?: number;
};

type Paired<Block> = {
  baseBlocks: readonly [Block, ...Block[]];
  revisedBlocks: readonly [Block, ...Block[]];
};

type RevisedOnly<Block> = {
  baseBlocks: readonly [];
  revisedBlocks: readonly [Block, ...Block[]];
};

type BaseOnly<Block> = {
  baseBlocks: readonly [Block, ...Block[]];
  revisedBlocks: readonly [];
};

/** The alignment events legal-ast needs to build comparison rows. */
export type StatuteComparisonEvent<
  Block extends StatuteComparisonBlock = StatuteComparisonBlock,
> =
  | ({ type: "unchanged" } & Paired<Block>)
  | ({
      type: "modified";
      segments: readonly StatuteWordDiffSegment[];
    } & Paired<Block>)
  | ({ type: "formatting" } & Paired<Block>)
  | ({ type: "inserted" } & RevisedOnly<Block>)
  | ({ type: "deleted" } & BaseOnly<Block>)
  | ({ type: "movedFrom"; moveId: number } & BaseOnly<Block>)
  | ({
      type: "movedTo";
      moveId: number;
      segments?: readonly StatuteWordDiffSegment[];
    } & RevisedOnly<Block>)
  | {
      type: "split";
      baseBlocks: readonly [Block];
      revisedBlocks: readonly [Block, Block];
    }
  | {
      type: "merge";
      baseBlocks: readonly [Block, Block];
      revisedBlocks: readonly [Block];
    };

/** Host-owned implementation of block alignment and word diffing. */
export type StatuteComparisonAdapter<Error> = {
  compare: <Block extends StatuteComparisonBlock>(options: {
    base: readonly Block[];
    revised: readonly Block[];
  }) => Result<readonly StatuteComparisonEvent<Block>[], Error>;
  diffWords: (
    before: string,
    after: string,
  ) => readonly StatuteWordDiffSegment[];
};
