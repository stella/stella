// Passive regression fixture for `no-layout-motion-classes/no-layout-motion-classes`.

const cn = (...parts: string[]): string => parts.join(" ");

// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves `transition-all` is rejected
const transitionAll = "transition-all duration-150";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves an arbitrary transition naming a layout property is rejected
const layoutTransition = "md:transition-[height] transition-[margin-inline]";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves viewport-unit utilities are rejected
const viewportUnits = "min-h-screen h-screen max-h-screen w-screen";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves template elements receive the same guard
const viewportTemplate = `flex min-h-screen`;
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- x2: fixture proves class-composer arguments receive the same guard
const composed = cn("transition-all", "min-h-screen");

// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves a vh length in an arbitrary value is rejected
const largeViewportLength = "max-h-[calc(100vh-3rem)]";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves ease-in is rejected
const easeIn = "transition-opacity ease-in";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves an entry from scale-0 is rejected
const scaleFromZero = "data-starting-style:scale-0";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves a UI duration above 300ms is rejected
const longDuration = "transition-opacity duration-500";
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves the hover: none media variant is rejected
const hoverNone = "opacity-0 [@media(hover:none)]:opacity-100";

const touchReveal = "opacity-0 pointer-coarse:opacity-100";

const namedTransitions =
  // expect-clean: no-layout-motion-classes/no-layout-motion-classes
  "transition-opacity transition-transform transition-none";
const dynamicViewport = "min-h-dvh h-dvh max-h-dvh w-dvw";
const compositableAnimation = "animate-[pulse_700ms_ease-in-out_3]";
const animationNamedAfterProperty = "animate-[height_200ms_ease-out]";
const shortMotion =
  "ease-out ease-in-out duration-300 data-starting-style:scale-95 max-h-[70dvh]";

export {
  animationNamedAfterProperty,
  composed,
  compositableAnimation,
  dynamicViewport,
  easeIn,
  hoverNone,
  largeViewportLength,
  longDuration,
  layoutTransition,
  namedTransitions,
  scaleFromZero,
  shortMotion,
  touchReveal,
  transitionAll,
  viewportTemplate,
  viewportUnits,
};
