// Names the shared types of the generated web API contract
// (apps/web/src/generated/api-routes.gen.ts).
//
// A name must survive unrelated edits to the contract, or every pull request
// that touches the file conflicts with every other one. So it depends only on
// where the type sits, never on the order the printer happened to reach it:
//
// - A path is property keys and structural positions (`[0]`, `(0)`, `<0>`),
//   joined by `/`. A union or intersection member is `|` or `&` with no index:
//   member order follows the compiler's type ids, and inserting a member would
//   otherwise shift every later one.
// - A type reached along several paths is named from the smallest one in plain
//   string order, never from the first one the traversal visited. A new reach
//   along a smaller path does rename it: naming by content alone would instead
//   rename a type, and every alias around it, whenever anything inside it
//   changes, which happens far more often.
// - A union or intersection member shares its path with every other member
//   there, so its name also carries a hash of everything it prints, and
//   members that print the same share the name. That holds from the first
//   member on, so adding a member renames none. Other shared types that end up
//   with the same path are told apart the same way. Only such a type is
//   renamed when something inside it changes; the types around it keep their
//   names.

import { panic } from "better-result";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

export type AliasGraphNode = {
  // Printed body; nested nodes appear as `\uE000<id>\uE000` tokens.
  body: string;
  references: number;
  recursive: boolean;
};

// One reach of `to`: from the root (`from` undefined) or from inside the body
// of node `from`, along `path` segments relative to that node.
export type AliasGraphEdge = {
  from: number | undefined;
  to: number;
  path: string;
};

const TOKEN = /\uE000(\d+)\uE000/gu;
const ALIAS_HASH_LENGTH = 10;

export const ALIAS_NAME = /\bT[0-9a-f]{10}\b/gu;

const hashName = (text: string): string =>
  `T${hashSha256Hex(text).slice(0, ALIAS_HASH_LENGTH)}`;

const joinPath = (base: string, relative: string): string => {
  if (base === "") {
    return relative;
  }
  return relative === "" ? base : `${base}/${relative}`;
};

type HeapItem = { path: string; id: number };

// Minimal binary min-heap keyed by path; ties never matter because a node
// settles once, on its smallest path.
const createPathHeap = () => {
  const items: HeapItem[] = [];
  const push = (item: HeapItem): void => {
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = items[parent];
      if (parentItem === undefined || parentItem.path <= item.path) {
        break;
      }
      items[index] = parentItem;
      index = parent;
    }
    items[index] = item;
  };
  const pop = (): HeapItem | undefined => {
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) {
      return top;
    }
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      let smallest = index;
      let smallestPath = last.path;
      for (const child of [left, left + 1]) {
        const childItem = items[child];
        if (childItem !== undefined && childItem.path < smallestPath) {
          smallest = child;
          smallestPath = childItem.path;
        }
      }
      if (smallest === index) {
        break;
      }
      items[index] = items[smallest] ?? panic("heap index out of range");
      index = smallest;
    }
    items[index] = last;
    return top;
  };
  return { push, pop, size: () => items.length };
};

/**
 * The smallest path to every node. Extending a path only makes it larger, so
 * a node is final the first time it leaves the heap (Dijkstra over string
 * order).
 */
const canonicalPaths = (
  nodeCount: number,
  edges: readonly AliasGraphEdge[],
): string[] => {
  const outgoing = new Map<number | undefined, AliasGraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const settled: (string | undefined)[] = Array.from({ length: nodeCount });
  const heap = createPathHeap();
  for (const edge of outgoing.get(undefined) ?? []) {
    heap.push({ path: edge.path, id: edge.to });
  }
  while (heap.size() > 0) {
    const next = heap.pop();
    if (next === undefined || settled[next.id] !== undefined) {
      continue;
    }
    settled[next.id] = next.path;
    for (const edge of outgoing.get(next.id) ?? []) {
      if (settled[edge.to] === undefined) {
        heap.push({ path: joinPath(next.path, edge.path), id: edge.to });
      }
    }
  }
  return settled.map(
    (value, id) => value ?? panic(`web-api alias names: node ${id} unreached`),
  );
};

const childrenOf = (node: AliasGraphNode): number[] =>
  [...node.body.matchAll(TOKEN)].map((match) => Number(match[1]));

/**
 * The strongly connected components of the graph formed by the tokens in
 * node bodies (Tarjan, iterative): two nodes share one when each reaches the
 * other. Components come out after every component they reach, and
 * `componentOf` maps a node to its index in that order.
 */
const componentsOf = (
  nodes: readonly AliasGraphNode[],
): { components: number[][]; componentOf: number[] } => {
  const children = nodes.map(childrenOf);
  const index: (number | undefined)[] = Array.from({ length: nodes.length });
  const low: number[] = Array.from({ length: nodes.length }, () => 0);
  const componentOf: number[] = Array.from({ length: nodes.length }, () => -1);
  const components: number[][] = [];
  const stack: number[] = [];
  const onStack = new Set<number>();
  let nextIndex = 0;
  for (const [start] of nodes.entries()) {
    if (index[start] !== undefined) {
      continue;
    }
    const frames: { id: number; child: number }[] = [{ id: start, child: 0 }];
    index[start] = nextIndex;
    low[start] = nextIndex;
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);
    while (frames.length > 0) {
      const frame = frames.at(-1) ?? panic("tarjan frame");
      const next = children[frame.id]?.[frame.child];
      if (next !== undefined) {
        frame.child += 1;
        const nextSeen = index[next];
        if (nextSeen === undefined) {
          index[next] = nextIndex;
          low[next] = nextIndex;
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ id: next, child: 0 });
        } else if (onStack.has(next)) {
          low[frame.id] = Math.min(low[frame.id] ?? 0, nextSeen);
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        low[parent.id] = Math.min(low[parent.id] ?? 0, low[frame.id] ?? 0);
      }
      if (low[frame.id] === index[frame.id]) {
        const members: number[] = [];
        for (;;) {
          const member = stack.pop() ?? panic("tarjan stack underflow");
          onStack.delete(member);
          componentOf[member] = components.length;
          members.push(member);
          if (member === frame.id) {
            break;
          }
        }
        components.push(members);
      }
    }
  }
  return { components, componentOf };
};

/**
 * A hash of everything a node prints, nested nodes included, so two nodes
 * share it only when they print the same type. A node is hashed with its
 * strongly connected component: the component's bodies in the order they are
 * first reached from the node, a reference inside the component written as
 * that position and one outside it as the target's hash, computed first. That
 * depends on neither node numbering nor which member of a cycle is hashed
 * first, and costs one walk of the component per member rather than one per
 * path through it.
 */
const structuralHashes = (nodes: readonly AliasGraphNode[]) => {
  const { components, componentOf } = componentsOf(nodes);
  const hashes: string[] = Array.from({ length: nodes.length }, () => "");
  for (const [component, members] of components.entries()) {
    for (const entry of members) {
      const order = [entry];
      const position = new Map([[entry, 0]]);
      const bodies: string[] = [];
      // `order` grows while it is walked; an array iterator reads its length
      // on every step, so the walk reaches every member.
      for (const id of order) {
        const node = nodes[id] ?? panic(`missing node ${id}`);
        bodies.push(
          node.body.replaceAll(TOKEN, (_match, rawId: string) => {
            const child = Number(rawId);
            if (componentOf[child] !== component) {
              return `\uE000=${hashes[child] ?? panic(`missing node ${child}`)}\uE000`;
            }
            let at = position.get(child);
            if (at === undefined) {
              at = order.length;
              position.set(child, at);
              order.push(child);
            }
            return `\uE000#${at}\uE000`;
          }),
        );
      }
      hashes[entry] = hashSha256Hex(bodies.join("\uE001"));
    }
  }
  return (id: number): string =>
    hashes[id] ?? panic(`web-api alias names: node ${id}`);
};

/** Whether a path ends at a union or intersection member position. */
const endsAtMemberPosition = (nodePath: string): boolean =>
  nodePath === "|" ||
  nodePath === "&" ||
  nodePath.endsWith("/|") ||
  nodePath.endsWith("/&");

/**
 * Names every shared (referenced more than once) or recursive node. The rest
 * are inlined by the printer and need no name. A path held by one shared node
 * names it; a union or intersection member, or a node sharing its path with
 * others, is also named by what it prints, and nodes that print the same type
 * share the name.
 */
export const nameAliases = (
  nodes: readonly AliasGraphNode[],
  edges: readonly AliasGraphEdge[],
): Map<number, string> => {
  const paths = canonicalPaths(nodes.length, edges);
  const byPath = new Map<string, number[]>();
  for (const [id, node] of nodes.entries()) {
    if (!node.recursive && node.references === 1) {
      continue;
    }
    const nodePath = paths[id] ?? panic(`web-api alias names: node ${id}`);
    const group = byPath.get(nodePath) ?? [];
    group.push(id);
    byPath.set(nodePath, group);
  }
  const structuralHash = structuralHashes(nodes);
  const names = new Map<number, string>();
  const keyByName = new Map<string, string>();
  for (const [nodePath, group] of byPath) {
    for (const id of group) {
      const key =
        group.length === 1 && !endsAtMemberPosition(nodePath)
          ? nodePath
          : `${nodePath}\u0000${structuralHash(id)}`;
      const name = hashName(key);
      const claimed = keyByName.get(name);
      if (claimed !== undefined && claimed !== key) {
        panic(`web-api alias names: alias name collision ${name}`);
      }
      keyByName.set(name, key);
      names.set(id, name);
    }
  }
  return names;
};
