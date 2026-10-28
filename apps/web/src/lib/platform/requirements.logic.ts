/**
 * What a control needs from the device or the layout before it is worth
 * offering. Two separate questions hide behind "mobile": whether the screen
 * has room (a layout fact that changes with the window) and what the device
 * can do (a fact about the machine, whatever the window width). Each
 * requirement answers exactly one of them, so a narrow desktop window keeps
 * its desktop-app actions and a wide tablet never offers them.
 */
export const REQUIREMENT = {
  /** The inspector docks beside the main view (the `md` layout and up). */
  sidePanel: "side-panel",
  /** The device can run the Stella desktop app (macOS or Windows). */
  desktopAppHost: "desktop-app-host",
} as const;

export type Requirement = (typeof REQUIREMENT)[keyof typeof REQUIREMENT];

export const AVAILABLE_EVERYWHERE = "everywhere" as const;

/**
 * Where a control is offered. A control with no requirement says so with
 * `AVAILABLE_EVERYWHERE` rather than an empty list, so the choice is written
 * down instead of falling out of an omission.
 */
export type Availability =
  typeof AVAILABLE_EVERYWHERE | readonly [Requirement, ...Requirement[]];

/** The requirements the current device and layout meet. */
export type PlatformCapabilities = ReadonlySet<Requirement>;

export const isAvailable = (
  availability: Availability,
  capabilities: PlatformCapabilities,
): boolean =>
  availability === AVAILABLE_EVERYWHERE ||
  availability.every((requirement) => capabilities.has(requirement));

export const filterAvailable = <Item extends { requires: Availability }>(
  items: readonly Item[],
  capabilities: PlatformCapabilities,
): Item[] => items.filter((item) => isAvailable(item.requires, capabilities));
