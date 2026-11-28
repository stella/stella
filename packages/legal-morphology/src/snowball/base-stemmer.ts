/**
 * TypeScript port of the Snowball JavaScript runtime (`javascript/base-stemmer.js`).
 *
 * Upstream: https://github.com/snowballstem/snowball
 * Version:  v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Source:   javascript/base-stemmer.js
 * SHA-256:  see SNOWBALL_BASE_STEMMER_SHA256 below; the regeneration script
 *           (`scripts/generate-snowball-stemmers.ts`) re-hashes the upstream
 *           file at the pinned tag and fails when this port has gone stale.
 *
 * The generated stemmers in this directory extend this class; the method
 * bodies are transcribed from upstream verbatim. Deviations are limited to
 * what the repo's `strict` + `noUncheckedIndexedAccess` TypeScript settings
 * require, and each one is marked with a `PORT:` comment.
 *
 * Copyright (c) 2001, Dr Martin Porter
 * Copyright (c) 2004,2005, Richard Boulton
 * Copyright (c) 2013, Yoshiki Shibukawa
 * Copyright (c) 2006-2025, Olly Betts
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 *   1. Redistributions of source code must retain the above copyright notice,
 *      this list of conditions and the following disclaimer.
 *   2. Redistributions in binary form must reproduce the above copyright
 *      notice, this list of conditions and the following disclaimer in the
 *      documentation and/or other materials provided with the distribution.
 *   3. Neither the name of the Snowball project nor the names of its
 *      contributors may be used to endorse or promote products derived from
 *      this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import { panic } from "better-result";

/**
 * The Snowball release every generated stemmer in this directory, and this
 * hand-port of its runtime, was cut from. The regeneration script clones this
 * tag rather than carrying a second copy of it, and the projection folds it
 * into what a stemmed generation fingerprints, so a release upgrade
 * re-projects the stems it changes.
 */
export const SNOWBALL_RELEASE = "v3.1.1";

/**
 * SHA-256 of upstream `javascript/base-stemmer.js` at the pinned tag. The
 * regeneration script compares the upstream file against this digest so an
 * upstream runtime change cannot land silently while this port stays put.
 */
export const SNOWBALL_BASE_STEMMER_SHA256 =
  "bf6f03e1a0d29d9e6e669a3a13069187e4095a8c67251e475f5b6b2102974e26";

/**
 * One row of a Snowball `among` table: the search string, the result code,
 * the relative back-jump to the previous candidate, and the index of the
 * among-condition routine. The generator omits the trailing fields when they
 * are unused, so they are modelled as optional rather than as a union of
 * tuple arities (which would make positional reads a type error).
 */
export type AmongRow = readonly [
  s: string,
  result: number,
  substringIndex?: number,
  amongFunction?: number,
];

export type AmongTable = readonly AmongRow[];

/** An among-condition routine, invoked with the stemmer as `this`. */
export type AmongFunction = () => boolean;

/**
 * Read a Snowball substitution table (`as_*` in generated code) at the index
 * a preceding `find_among` returned. The generator only emits this read on a
 * matched branch, so an out-of-range index means the generated code and its
 * table disagree: a bug, never a runtime condition.
 */
export const substitution = (
  table: readonly string[],
  index: number,
): string =>
  table[index] ??
  panic(
    `Snowball substitution table has no entry at index ${index} (size ${table.length})`,
  );

export class BaseStemmer {
  protected current = "";
  protected c = 0;
  protected limit = 0;
  protected limit_backward = 0;
  protected bra = 0;
  protected ket = 0;
  protected af = 0;

  setCurrent(value: string) {
    this.current = value;
    this.c = 0;
    this.limit = this.current.length;
    this.limit_backward = 0;
    this.bra = this.c;
    this.ket = this.limit;
  }

  getCurrent(): string {
    return this.current;
  }

  protected copy_from(other: BaseStemmer) {
    this.current = other.current;
    this.c = other.c;
    this.limit = other.limit;
    this.limit_backward = other.limit_backward;
    this.bra = other.bra;
    this.ket = other.ket;
  }

  protected in_grouping(s: readonly number[], min: number, max: number) {
    if (this.c >= this.limit) return false;
    let ch = this.current.charCodeAt(this.c);
    if (ch > max || ch < min) return false;
    ch -= min;
    // PORT: `?? 0` stands in for JS's `undefined` read, which the bitwise
    // `&` would have coerced to 0 anyway. The `min`/`max` guard above keeps
    // the index in range in practice.
    if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) return false;
    this.c++;
    return true;
  }

  protected go_in_grouping(s: readonly number[], min: number, max: number) {
    while (this.c < this.limit) {
      let ch = this.current.charCodeAt(this.c);
      if (ch > max || ch < min) return true;
      ch -= min;
      if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) return true;
      this.c++;
    }
    return false;
  }

  protected in_grouping_b(s: readonly number[], min: number, max: number) {
    if (this.c <= this.limit_backward) return false;
    let ch = this.current.charCodeAt(this.c - 1);
    if (ch > max || ch < min) return false;
    ch -= min;
    if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) return false;
    this.c--;
    return true;
  }

  protected go_in_grouping_b(s: readonly number[], min: number, max: number) {
    while (this.c > this.limit_backward) {
      let ch = this.current.charCodeAt(this.c - 1);
      if (ch > max || ch < min) return true;
      ch -= min;
      if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) return true;
      this.c--;
    }
    return false;
  }

  protected out_grouping(s: readonly number[], min: number, max: number) {
    if (this.c >= this.limit) return false;
    let ch = this.current.charCodeAt(this.c);
    if (ch > max || ch < min) {
      this.c++;
      return true;
    }
    ch -= min;
    if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) {
      this.c++;
      return true;
    }
    return false;
  }

  protected go_out_grouping(s: readonly number[], min: number, max: number) {
    while (this.c < this.limit) {
      let ch = this.current.charCodeAt(this.c);
      if (ch <= max && ch >= min) {
        ch -= min;
        if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) !== 0) {
          return true;
        }
      }
      this.c++;
    }
    return false;
  }

  protected out_grouping_b(s: readonly number[], min: number, max: number) {
    if (this.c <= this.limit_backward) return false;
    let ch = this.current.charCodeAt(this.c - 1);
    if (ch > max || ch < min) {
      this.c--;
      return true;
    }
    ch -= min;
    if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) === 0) {
      this.c--;
      return true;
    }
    return false;
  }

  protected go_out_grouping_b(s: readonly number[], min: number, max: number) {
    while (this.c > this.limit_backward) {
      let ch = this.current.charCodeAt(this.c - 1);
      if (ch <= max && ch >= min) {
        ch -= min;
        if (((s[ch >>> 3] ?? 0) & (0x1 << (ch & 0x7))) !== 0) {
          return true;
        }
      }
      this.c--;
    }
    return false;
  }

  protected eq_s(s: string) {
    if (this.limit - this.c < s.length) return false;
    if (!this.current.startsWith(s, this.c)) return false;
    this.c += s.length;
    return true;
  }

  protected eq_s_b(s: string) {
    if (this.c - this.limit_backward < s.length) return false;
    if (!this.current.endsWith(s, this.c)) return false;
    this.c -= s.length;
    return true;
  }

  protected find_among(
    v: AmongTable,
    call_among_func?: AmongFunction,
  ): number {
    let i = 0;
    let j = v.length;

    const c = this.c;
    const l = this.limit;

    let common_i = 0;
    let common_j = 0;

    let first_key_inspected = false;

    for (;;) {
      const k = i + ((j - i) >>> 1);
      let diff = 0;
      let common = common_i < common_j ? common_i : common_j; // smaller
      const w = this.#row(v, k);
      let i2: number;
      for (i2 = common; i2 < w[0].length; i2++) {
        if (c + common === l) {
          diff = -1;
          break;
        }
        diff = this.current.charCodeAt(c + common) - w[0].charCodeAt(i2);
        if (diff !== 0) break;
        common++;
      }
      if (diff < 0) {
        j = k;
        common_j = common;
      } else {
        i = k;
        common_i = common;
      }
      if (j - i <= 1) {
        if (i > 0) break; // v->s has been inspected
        if (j === i) break; // only one item in v

        // - but now we need to go round once more to get
        // v->s inspected. This looks messy, but is actually
        // the optimal approach.

        if (first_key_inspected) break;
        first_key_inspected = true;
      }
    }
    for (;;) {
      const w = this.#row(v, i);
      if (common_i >= w[0].length) {
        this.c = c + w[0].length;
        if (w.length < 4) return w[1];
        this.af = w[3] ?? 0;
        if (call_among_func?.call(this) === true) {
          this.c = c + w[0].length;
          return w[1];
        }
      }
      // Tests for undefined (if w.length < 2) or 0.
      const back = w[2];
      if (!back) return 0;
      i -= back;
    }
  }

  // find_among_b is for backwards processing. Same comments apply
  protected find_among_b(
    v: AmongTable,
    call_among_func?: AmongFunction,
  ): number {
    let i = 0;
    let j = v.length;

    const c = this.c;
    const lb = this.limit_backward;

    let common_i = 0;
    let common_j = 0;

    let first_key_inspected = false;

    for (;;) {
      const k = i + ((j - i) >> 1);
      let diff = 0;
      let common = common_i < common_j ? common_i : common_j;
      const w = this.#row(v, k);
      let i2: number;
      for (i2 = w[0].length - 1 - common; i2 >= 0; i2--) {
        if (c - common === lb) {
          diff = -1;
          break;
        }
        diff = this.current.charCodeAt(c - 1 - common) - w[0].charCodeAt(i2);
        if (diff !== 0) break;
        common++;
      }
      if (diff < 0) {
        j = k;
        common_j = common;
      } else {
        i = k;
        common_i = common;
      }
      if (j - i <= 1) {
        if (i > 0) break;
        if (j === i) break;
        if (first_key_inspected) break;
        first_key_inspected = true;
      }
    }
    for (;;) {
      const w = this.#row(v, i);
      if (common_i >= w[0].length) {
        this.c = c - w[0].length;
        if (w.length < 4) return w[1];
        this.af = w[3] ?? 0;
        if (call_among_func?.call(this) === true) {
          this.c = c - w[0].length;
          return w[1];
        }
      }
      // Tests for undefined (if w.length < 2) or 0.
      const back = w[2];
      if (!back) return 0;
      i -= back;
    }
  }

  /**
   * PORT: upstream indexes the among table directly. The binary search keeps
   * the index inside the table, so a miss means the generated table and the
   * search disagree.
   */
  #row(v: AmongTable, index: number): AmongRow {
    return (
      v[index] ??
      panic(
        `Snowball among table has no row at index ${index} (size ${v.length})`,
      )
    );
  }

  /* to replace chars between c_bra and c_ket in this.current by the
   * chars in s.
   */
  #replace_s(c_bra: number, c_ket: number, s: string): number {
    const adjustment = s.length - (c_ket - c_bra);
    this.current =
      this.current.slice(0, c_bra) + s + this.current.slice(c_ket);
    this.limit += adjustment;
    if (this.c >= c_ket) this.c += adjustment;
    else if (this.c > c_bra) this.c = c_bra;
    return adjustment;
  }

  /**
   * PORT: upstream calls `console.assert` here. The invariants are internal
   * to the generated algorithms, so a violation is a bug in this module, not
   * a runtime condition to log past.
   */
  #slice_check() {
    if (
      this.bra < 0 ||
      this.bra > this.ket ||
      this.ket > this.limit ||
      this.limit > this.current.length
    ) {
      panic(
        `Snowball slice bounds violated: bra=${this.bra} ket=${this.ket} limit=${this.limit} length=${this.current.length}`,
      );
    }
  }

  protected slice_from(s: string) {
    this.#slice_check();
    this.#replace_s(this.bra, this.ket, s);
    this.ket = this.bra + s.length;
  }

  protected slice_del() {
    this.slice_from("");
  }

  protected insert(c_bra: number, c_ket: number, s: string) {
    const adjustment = this.#replace_s(c_bra, c_ket, s);
    if (c_bra <= this.bra) this.bra += adjustment;
    if (c_bra <= this.ket) this.ket += adjustment;
  }

  protected slice_to(): string {
    this.#slice_check();
    return this.current.slice(this.bra, this.ket);
  }
}
