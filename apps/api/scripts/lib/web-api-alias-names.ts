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
//   string order, never from the first one the traversal visited.
// - Shared types that end up with the same path (members of one union, say)
//   are told apart by a hash of everything they print, and share the name
//   when they print the same type. Only such a type is renamed when something
//   inside it changes; the types around it keep their names.

import { panic } from "better-result";
import { createHash } from "node:crypto";

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
  `T${createHash("sha256").update(text).digest("hex").slice(0, ALIAS_HASH_LENGTH)}`;

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
export const canonicalPaths = (
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

/**
 * A hash of everything a node prints, nested nodes included, so two nodes
 * share it only when they print the same type. A cycle back to a node still
 * being hashed is written as its distance up the stack; a hash that depends on
 * such an outer node is not cached, since it differs by where it is reached.
 */
const structuralHashes = (nodes: readonly AliasGraphNode[]) => {
  const cache = new Map<number, string>();
  const stack: number[] = [];
  const visit = (id: number): { hash: string; outermost: number } => {
    const onStack = stack.lastIndexOf(id);
    if (onStack !== -1) {
      return { hash: `^${stack.length - 1 - onStack}`, outermost: onStack };
    }
    const cached = cache.get(id);
    if (cached !== undefined) {
      return { hash: cached, outermost: Number.POSITIVE_INFINITY };
    }
    const depth = stack.length;
    stack.push(id);
    let outermost = Number.POSITIVE_INFINITY;
    const body = (nodes[id] ?? panic(`missing node ${id}`)).body.replaceAll(
      TOKEN,
      (_match, rawId: string) => {
        const nested = visit(Number(rawId));
        outermost = Math.min(outermost, nested.outermost);
        return `\uE000${nested.hash}\uE000`;
      },
    );
    stack.pop();
    const hash = createHash("sha256").update(body).digest("hex");
    if (outermost >= depth) {
      cache.set(id, hash);
      return { hash, outermost: Number.POSITIVE_INFINITY };
    }
    return { hash, outermost };
  };
  return (id: number): string => visit(id).hash;
};

/**
 * Names every shared (referenced more than once) or recursive node. The rest
 * are inlined by the printer and need no name. A path held by one shared node
 * names it; nodes sharing a path are told apart by what they print, and nodes
 * that print the same type share the name.
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
        group.length === 1
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
