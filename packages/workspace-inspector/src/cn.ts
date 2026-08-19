import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Local copy of Stella's `@stll/ui` `cn`. The published package keeps no
 * workspace dependency, so consumers outside the monorepo can install it
 * without pulling a private design-system package.
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
