# useEffect Conventions

Apply when writing or reviewing React code in `apps/web`.

Direct `useEffect` is **banned** in `apps/web/src` and enforced by the
`no-raw-use-effect` lint rule. Most effects compensate for primitives React
already gives you; the rest are external-system synchronization that must go
through a named wrapper so intent is explicit and greppable. React Compiler is
enabled tree-wide, so "derive during render" costs nothing.

Background: React's own guide,
[You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).

## Decision order

Before reaching for any effect, walk this list top to bottom and stop at the
first match:

1. **Can it be derived during render?** Then derive it. (Rule 1)
2. **Is it data fetching?** Use TanStack Query. (Rule 2)
3. **Does it happen in response to a user action?** Do it in the event handler. (Rule 3)
4. **Does it reset state when an id/prop changes?** Remount with `key`. (Rule 5)
5. **Is it genuine external-system synchronization?** Use `useMountEffect`
   or `useExternalSyncEffect`. (Rule 4)

If none match, you almost certainly do not need an effect.

## Rule 1 — derive state, do not sync it

```tsx
// ❌ extra render + loop hazard
const [filtered, setFiltered] = useState([]);
useEffect(() => setFiltered(products.filter((p) => p.inStock)), [products]);

// ✅ compute inline (React Compiler memoizes it)
const filtered = products.filter((p) => p.inStock);
```

Smell: `useEffect(() => setX(deriveFrom(y)), [y])`, or state that only mirrors
other state/props.

## Rule 2 — data-fetching library, not an effect

```tsx
// ❌ race conditions, hand-rolled caching
useEffect(() => { fetchProduct(id).then(setProduct); }, [id]);

// ✅ cancellation/caching/staleness handled for you
const { data: product } = useQuery(productOptions(id));
```

Smell: an effect that does `fetch(...)` then `setState(...)`, or re-implements
retries/cancellation/staleness.

## Rule 3 — event handlers, not effects

```tsx
// ❌ effect as an action relay
useEffect(() => { if (liked) { postLike(); setLiked(false); } }, [liked]);

// ✅ do the work where the event happens
<button onClick={() => postLike()}>Like</button>
```

Smell: state used as a flag so an effect can run the real action
("set flag → effect runs → reset flag").

## Rule 5 — reset with `key`, not dependency choreography

```tsx
// ✅ a new id gives a brand-new instance; mount logic runs once, cleanly
<Editor key={documentId} documentId={documentId} />
```

Smell: an effect whose only job is to reset local state when an id changes.

## Rule 4 — the two sanctioned wrappers

Both live in `@/hooks/use-effect` and are the only place a raw `useEffect`
may be called.

### `useMountEffect(effect)`

Setup/teardown on mount, once. For DOM imperatives (focus, scroll), third-party
widget lifecycles, and browser-API subscriptions.

```tsx
useMountEffect(() => {
  const controller = new AbortController();
  window.addEventListener("resize", onResize, { signal: controller.signal });
  return () => controller.abort();
});
```

### `useExternalSyncEffect(effect, deps)`

Push a **changing** React value into an external system when it changes. The
only sanctioned dependency-array effect. Every call must be an external-system
sync — never derived state, an event relay, or a fetch.

```tsx
// Push zoom into the imperative folio editor whenever it changes.
useExternalSyncEffect(() => editorRef.current?.setZoom(zoom), [zoom]);
```

When the external lifecycle is "set up once per DOM node," prefer a **callback
ref** over an effect (it ties setup/teardown to the node, not to a render) — see
the `ResizeObserver`/fit-zoom pattern in the docx viewers.

## useLayoutEffect

Not covered by the ban (it has legitimate pre-paint imperative uses), but the
same decision order applies. Reach for it only when a measurement or imperative
write must happen before the browser paints.

## Escape hatch

For a genuine effect that does not fit either wrapper (or that is pending
migration), suppress at the call site with a reason — `suppression-hygiene`
requires the description:

```tsx
// oxlint-disable-next-line no-raw-use-effect/no-raw-use-effect -- <why a wrapper does not fit>
useEffect(/* ... */);
```

Prefer fixing over suppressing. A bare disable with no reason is itself a lint
error.

## Scope

Enforced in `apps/web/src`. `packages/folio` is intentionally exempt: it is
upstream-synced and is an inherently imperative editor where most effects are
legitimate external-system sync, so the rule would generate suppression noise
and fight every upstream merge for little benefit.
