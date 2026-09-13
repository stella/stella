// Passive regression fixture for
// `no-decorated-search-input/no-decorated-search-input`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { SearchIcon, SlidersHorizontalIcon } from "lucide-react";

import { Input } from "@stll/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";

const Input2 = (props: { className?: string; type?: string }) => (
  <input {...props} />
);
const query = "";
const noop = () => undefined;

// --- Flagged: caller re-adds the leading padding the primitive reserves ---
export const _a = () => (
  // oxlint-disable-next-line no-decorated-search-input/no-decorated-search-input
  <Input className="ps-9" type="search" />
);
export const _b = () => (
  // oxlint-disable-next-line no-decorated-search-input/no-decorated-search-input
  <InputGroupInput className="h-7 pl-8 text-xs" type="search" />
);
export const _c = () => (
  // oxlint-disable-next-line no-decorated-search-input/no-decorated-search-input
  <Input className="sm:ps-10" type="search" />
);

// --- Flagged: a second search icon drawn ahead of the field ---
export const _d = () => (
  <div className="relative">
    {/* oxlint-disable-next-line no-decorated-search-input/no-decorated-search-input */}
    <SearchIcon className="absolute start-2 size-4" />
    <Input type="search" />
  </div>
);

// --- Flagged: an addon holding the icon beside a grouped search input ---
export const _e = () => (
  <InputGroup>
    <InputGroupAddon>
      {/* oxlint-disable-next-line no-decorated-search-input/no-decorated-search-input */}
      <SearchIcon />
    </InputGroupAddon>
    <InputGroupInput onChange={noop} type="search" value={query} />
  </InputGroup>
);

// --- Allowed: the primitive draws the icon and reserves the space ---
export const _ok1 = () => <Input type="search" />;
export const _ok2 = () => (
  <InputGroup>
    <InputGroupInput type="search" />
  </InputGroup>
);
// Allowed: trailing padding leaves the icon's inline-start space alone.
export const _ok3 = () => <Input className="h-7 pe-8" type="search" />;
// Allowed: leading padding on an input the primitive does not decorate.
export const _ok4 = () => <Input className="ps-8" type="text" />;
// Allowed: a search icon beside a non-search input.
export const _ok5 = () => (
  <div className="relative">
    <SearchIcon className="absolute start-2 size-4" />
    <Input type="text" />
  </div>
);
// Allowed: an addon carrying a different affordance.
export const _ok6 = () => (
  <InputGroup>
    <InputGroupAddon align="inline-end">
      <SlidersHorizontalIcon />
    </InputGroupAddon>
    <InputGroupInput type="search" />
  </InputGroup>
);
// Allowed: a local component that merely shares the primitive's name.
export const _ok7 = () => <Input2 className="ps-9" type="search" />;
