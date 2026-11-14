// Positive fixtures are enforced through unused-disable checks and exact counts.

import { StellaMark } from "@stll/ui/stella-mark";
import type { ComponentType, PropsWithChildren } from "react";

declare const BrandMark: ComponentType<PropsWithChildren>;
declare const Landmark: ComponentType<PropsWithChildren>;
declare const dynamicMark: string;

// The extension popup before the symbol fix.
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- sampled popup placeholder
export const popup = <div className="mark" aria-hidden="true">S</div>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- lowercase logo placeholder
export const lowercase = <span className="stella-logo">s</span>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- named component placeholder
export const component = <BrandMark>{"S"}</BrandMark>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- accessible brand identity
export const labelled = <div aria-label="stella logo">S</div>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- data attribute names identity
export const dataName = <div data-app-icon>S</div>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- data value names identity
export const dataValue = <div data-testid="brand-mark">S</div>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark, no-section-sign-glyph/no-section-sign-glyph -- literal glyph is still not the symbol
export const section = <div className="mark">§</div>;
// oxlint-disable-next-line no-placeholder-stella-mark/no-placeholder-stella-mark -- comments render nothing
export const comment = <div className={"app-icon"}>{/* decoration */}{`s`}</div>;

// expect-clean: no-placeholder-stella-mark/no-placeholder-stella-mark
export const size = <span className="size-label">S</span>;
export const word = <div className="brand">stella</div>;
export const legal = <span>§ 10</span>;
export const splitLegal = <div className="mark">§ <a href="/section/10">10</a></div>;
export const realSymbol = <div className="mark"><StellaMark /></div>;
export const unrelatedName = <Landmark>S</Landmark>;
export const dynamic = <div className="mark">{dynamicMark}</div>;
