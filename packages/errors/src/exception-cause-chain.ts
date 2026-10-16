// parser-output-unchanged: class and positional discriminator projections affect exception grouping only.
import { Result } from "better-result";

export const MAX_EXCEPTION_CAUSE_DEPTH = 6;

type CauseChainNode<TNode> = {
  type: string;
  cause?: TNode | undefined;
};

type ExceptionCauseChainOptions<TNode> = {
  root: TNode | undefined;
  readNode: (node: TNode) => CauseChainNode<TNode>;
};

const classIdentity = (type: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$.-]{0,159}$/u.test(type) ? type : "UnknownError";

/** Project outermost-first classes from a guarded snapshot or SDK entries. */
export const exceptionCauseChainIdentity = <TNode>({
  root,
  readNode,
}: ExceptionCauseChainOptions<TNode>): readonly string[] => {
  const classes: string[] = [];
  const seen = new Set<TNode>();
  let current = root;
  while (
    current !== undefined &&
    !seen.has(current) &&
    classes.length < MAX_EXCEPTION_CAUSE_DEPTH
  ) {
    const node = current;
    seen.add(node);
    const read = Result.try(() => readNode(node));
    if (Result.isError(read)) {
      classes.push("UnknownError");
      break;
    }
    classes.push(classIdentity(read.value.type));
    current = read.value.cause;
  }
  return classes.length === 0 ? ["UnknownError"] : classes;
};

export type ExceptionIdentityNode = {
  type: string;
  discriminators?: Readonly<Record<string, string>> | undefined;
};

type ExceptionDiscriminatorEntry = readonly [
  index: number,
  type: string,
  field: string,
  value: string,
];

/** Preserve causal position before canonicalizing each node's declared fields. */
export const exceptionDiscriminatorIdentity = (
  nodes: readonly ExceptionIdentityNode[],
): readonly ExceptionDiscriminatorEntry[] =>
  nodes.slice(0, MAX_EXCEPTION_CAUSE_DEPTH).flatMap((node, index) =>
    Object.entries(node.discriminators ?? {})
      .toSorted(([left], [right]) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      })
      .map(
        ([field, value]) =>
          [index, classIdentity(node.type), field, value] as const,
      ),
  );
