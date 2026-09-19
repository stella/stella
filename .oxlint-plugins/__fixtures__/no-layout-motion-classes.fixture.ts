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
// oxlint-disable-next-line no-layout-motion-classes/no-layout-motion-classes -- fixture proves class-composer arguments receive the same guard
const composed = cn("transition-all", "min-h-screen");

const namedTransitions =
  "transition-opacity transition-transform transition-none";
const dynamicViewport = "min-h-dvh h-dvh max-h-dvh w-dvw";
const compositableAnimation = "animate-[pulse_700ms_ease-in-out_3]";
const animationNamedAfterProperty = "animate-[height_200ms_ease-out]";

export {
  animationNamedAfterProperty,
  composed,
  compositableAnimation,
  dynamicViewport,
  layoutTransition,
  namedTransitions,
  transitionAll,
  viewportTemplate,
  viewportUnits,
};
