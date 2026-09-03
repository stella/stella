/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/greek.sbl -js -o greek
 *
 * The generator emits JavaScript; the committed module is that output with
 * mechanical, script-applied edits only (module header, named export, type
 * annotations the repo's strict TypeScript settings require, total
 * substitution-table reads, and the removal of labels nothing jumps to).
 * No algorithm logic is edited.
 *
 * Copyright (c) 2001, Dr Martin Porter
 * Copyright (c) 2004,2005, Richard Boulton
 * Copyright (c) 2013, Yoshiki Shibukawa
 * Copyright (c) 2006-2025, Olly Betts
 * All rights reserved. Distributed under the BSD 3-Clause licence; see the
 * full notice in ./base-stemmer.ts.
 */

import type { AmongTable } from "@/api/lib/legal-search/morphology/snowball/base-stemmer";
import {
  BaseStemmer,
  substitution,
} from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

// Generated from greek.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["", 25],
    ["\u0386", 1, 1],
    ["\u0388", 5, 2],
    ["\u0389", 7, 3],
    ["\u038A", 9, 4],
    ["\u038C", 15, 5],
    ["\u038E", 20, 6],
    ["\u038F", 24, 7],
    ["\u0390", 7, 8],
    ["\u0391", 1, 9],
    ["\u0392", 2, 10],
    ["\u0393", 3, 11],
    ["\u0394", 4, 12],
    ["\u0395", 5, 13],
    ["\u0396", 6, 14],
    ["\u0397", 7, 15],
    ["\u0398", 8, 16],
    ["\u0399", 9, 17],
    ["\u039A", 10, 18],
    ["\u039B", 11, 19],
    ["\u039C", 12, 20],
    ["\u039D", 13, 21],
    ["\u039E", 14, 22],
    ["\u039F", 15, 23],
    ["\u03A0", 16, 24],
    ["\u03A1", 17, 25],
    ["\u03A3", 18, 26],
    ["\u03A4", 19, 27],
    ["\u03A5", 20, 28],
    ["\u03A6", 21, 29],
    ["\u03A7", 22, 30],
    ["\u03A8", 23, 31],
    ["\u03A9", 24, 32],
    ["\u03AA", 9, 33],
    ["\u03AB", 20, 34],
    ["\u03AC", 1, 35],
    ["\u03AD", 5, 36],
    ["\u03AE", 7, 37],
    ["\u03AF", 9, 38],
    ["\u03B0", 20, 39],
    ["\u03C2", 18, 40],
    ["\u03CA", 7, 41],
    ["\u03CB", 20, 42],
    ["\u03CC", 15, 43],
    ["\u03CD", 20, 44],
    ["\u03CE", 24, 45]
];

const a_1: AmongTable = [
    ["\u03C3\u03BA\u03B1\u03B3\u03B9\u03B1", 2],
    ["\u03C6\u03B1\u03B3\u03B9\u03B1", 1],
    ["\u03BF\u03BB\u03BF\u03B3\u03B9\u03B1", 3],
    ["\u03C3\u03BF\u03B3\u03B9\u03B1", 4],
    ["\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03B1", 5],
    ["\u03BA\u03C1\u03B5\u03B1\u03C4\u03B1", 6],
    ["\u03C0\u03B5\u03C1\u03B1\u03C4\u03B1", 7],
    ["\u03C4\u03B5\u03C1\u03B1\u03C4\u03B1", 8],
    ["\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03B1", 11],
    ["\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03B1", 10],
    ["\u03C6\u03C9\u03C4\u03B1", 9],
    ["\u03C0\u03B5\u03C1\u03B1\u03C4\u03B7", 7],
    ["\u03C3\u03BA\u03B1\u03B3\u03B9\u03C9\u03BD", 2],
    ["\u03C6\u03B1\u03B3\u03B9\u03C9\u03BD", 1],
    ["\u03BF\u03BB\u03BF\u03B3\u03B9\u03C9\u03BD", 3],
    ["\u03C3\u03BF\u03B3\u03B9\u03C9\u03BD", 4],
    ["\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03C9\u03BD", 5],
    ["\u03BA\u03C1\u03B5\u03B1\u03C4\u03C9\u03BD", 6],
    ["\u03C0\u03B5\u03C1\u03B1\u03C4\u03C9\u03BD", 7],
    ["\u03C4\u03B5\u03C1\u03B1\u03C4\u03C9\u03BD", 8],
    ["\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03C9\u03BD", 11],
    ["\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03C9\u03BD", 10],
    ["\u03C6\u03C9\u03C4\u03C9\u03BD", 9],
    ["\u03BA\u03C1\u03B5\u03B1\u03C3", 6],
    ["\u03C0\u03B5\u03C1\u03B1\u03C3", 7],
    ["\u03C4\u03B5\u03C1\u03B1\u03C3", 8],
    ["\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C3", 11],
    ["\u03BA\u03C1\u03B5\u03B1\u03C4\u03BF\u03C3", 6],
    ["\u03C0\u03B5\u03C1\u03B1\u03C4\u03BF\u03C3", 7],
    ["\u03C4\u03B5\u03C1\u03B1\u03C4\u03BF\u03C3", 8],
    ["\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03BF\u03C3", 11],
    ["\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03BF\u03C3", 10],
    ["\u03C6\u03C9\u03C4\u03BF\u03C3", 9],
    ["\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C3", 10],
    ["\u03C6\u03C9\u03C3", 9],
    ["\u03C3\u03BA\u03B1\u03B3\u03B9\u03BF\u03C5", 2],
    ["\u03C6\u03B1\u03B3\u03B9\u03BF\u03C5", 1],
    ["\u03BF\u03BB\u03BF\u03B3\u03B9\u03BF\u03C5", 3],
    ["\u03C3\u03BF\u03B3\u03B9\u03BF\u03C5", 4],
    ["\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03BF\u03C5", 5]
];

const as_1: readonly string[] = ["\u03C6\u03B1", "\u03C3\u03BA\u03B1", "\u03BF\u03BB\u03BF", "\u03C3\u03BF", "\u03C4\u03B1\u03C4\u03BF", "\u03BA\u03C1\u03B5", "\u03C0\u03B5\u03C1", "\u03C4\u03B5\u03C1", "\u03C6\u03C9", "\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4", "\u03B3\u03B5\u03B3\u03BF\u03BD"];

const a_2: AmongTable = [
    ["\u03C0\u03B1", 1],
    ["\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1", 1, 1],
    ["\u03B5\u03C0\u03B1", 1, 2],
    ["\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1", 1, 3],
    ["\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1", 1, 4],
    ["\u03B5\u03BC\u03C0\u03B1", 1, 5],
    ["\u03B2", 2],
    ["\u03B4\u03B1\u03BD\u03B5", 1],
    ["\u03B2\u03B1\u03B8\u03C5\u03C1\u03B9", 2],
    ["\u03B2\u03B1\u03C1\u03BA", 2],
    ["\u03BC\u03B1\u03C1\u03BA", 2],
    ["\u03BB", 2],
    ["\u03BC", 2],
    ["\u03BA\u03BF\u03C1\u03BD", 2],
    ["\u03B1\u03B8\u03C1\u03BF", 1],
    ["\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF", 1, 1],
    ["\u03C0", 2],
    ["\u03B9\u03BC\u03C0", 2, 1],
    ["\u03C1", 2],
    ["\u03BC\u03B1\u03C1", 2, 1],
    ["\u03B1\u03BC\u03C0\u03B1\u03C1", 2, 2],
    ["\u03B3\u03BA\u03C1", 2, 3],
    ["\u03B2\u03BF\u03BB\u03B2\u03BF\u03C1", 2, 4],
    ["\u03B3\u03BB\u03C5\u03BA\u03BF\u03C1", 2, 5],
    ["\u03C0\u03B9\u03C0\u03B5\u03C1\u03BF\u03C1", 2, 6],
    ["\u03C0\u03C1", 2, 7],
    ["\u03BC\u03C0\u03C1", 2, 1],
    ["\u03B1\u03C1\u03C1", 2, 9],
    ["\u03B3\u03BB\u03C5\u03BA\u03C5\u03C1", 2, 10],
    ["\u03C0\u03BF\u03BB\u03C5\u03C1", 2, 11],
    ["\u03BB\u03BF\u03C5", 2]
];

const as_2: readonly string[] = ["\u03B9", "\u03B9\u03B6"];

const a_3: AmongTable = [
    ["\u03B9\u03B6\u03B1", 1],
    ["\u03B9\u03B6\u03B5", 1],
    ["\u03B9\u03B6\u03B1\u03BC\u03B5", 1],
    ["\u03B9\u03B6\u03BF\u03C5\u03BC\u03B5", 1],
    ["\u03B9\u03B6\u03B1\u03BD\u03B5", 1],
    ["\u03B9\u03B6\u03BF\u03C5\u03BD\u03B5", 1],
    ["\u03B9\u03B6\u03B1\u03C4\u03B5", 1],
    ["\u03B9\u03B6\u03B5\u03C4\u03B5", 1],
    ["\u03B9\u03B6\u03B5\u03B9", 1],
    ["\u03B9\u03B6\u03B1\u03BD", 1],
    ["\u03B9\u03B6\u03BF\u03C5\u03BD", 1],
    ["\u03B9\u03B6\u03B5\u03C3", 1],
    ["\u03B9\u03B6\u03B5\u03B9\u03C3", 1],
    ["\u03B9\u03B6\u03C9", 1]
];

const a_4: AmongTable = [
    ["\u03B2\u03B9", 1],
    ["\u03BB\u03B9", 1],
    ["\u03B1\u03BB", 1],
    ["\u03B5\u03BD", 1],
    ["\u03C3", 1],
    ["\u03C7", 1],
    ["\u03C5\u03C8", 1],
    ["\u03B6\u03C9", 1]
];

const a_5: AmongTable = [
    ["\u03C9\u03B8\u03B7\u03BA\u03B1", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B5", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B1\u03BC\u03B5", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B1\u03BD\u03B5", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B1\u03C4\u03B5", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B1\u03BD", 1],
    ["\u03C9\u03B8\u03B7\u03BA\u03B5\u03C3", 1]
];

const a_6: AmongTable = [
    ["\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1", 1],
    ["\u03B5\u03C0\u03B1", 1],
    ["\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1", 1],
    ["\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1", 1],
    ["\u03B5\u03BC\u03C0\u03B1", 1],
    ["\u03C7\u03B1\u03C1\u03C4\u03BF\u03C0\u03B1", 1],
    ["\u03B5\u03BE\u03B1\u03C1\u03C7\u03B1", 1],
    ["\u03B3\u03B5", 2],
    ["\u03B3\u03BA\u03B5", 2],
    ["\u03BA\u03BB\u03B5", 1],
    ["\u03B5\u03BA\u03BB\u03B5", 1, 1],
    ["\u03B1\u03C0\u03B5\u03BA\u03BB\u03B5", 1, 1],
    ["\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5", 1, 3],
    ["\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5", 1, 4],
    ["\u03B4\u03B1\u03BD\u03B5", 1],
    ["\u03C0\u03B5", 1],
    ["\u03B5\u03C0\u03B5", 1, 1],
    ["\u03BC\u03B5\u03C4\u03B5\u03C0\u03B5", 1, 1],
    ["\u03B5\u03C3\u03B5", 1],
    ["\u03B3\u03BA", 2],
    ["\u03BC", 2],
    ["\u03C0\u03BF\u03C5\u03BA\u03B1\u03BC", 2, 1],
    ["\u03BA\u03BF\u03BC", 2, 2],
    ["\u03B1\u03BD", 2],
    ["\u03BF\u03BB\u03BF", 2],
    ["\u03B1\u03B8\u03C1\u03BF", 1],
    ["\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF", 1, 1],
    ["\u03C0", 2],
    ["\u03BB\u03B1\u03C1", 2],
    ["\u03B4\u03B7\u03BC\u03BF\u03BA\u03C1\u03B1\u03C4", 2],
    ["\u03B1\u03C6", 2],
    ["\u03B3\u03B9\u03B3\u03B1\u03BD\u03C4\u03BF\u03B1\u03C6", 2, 1]
];

const as_6: readonly string[] = ["\u03B9", "\u03B9\u03C3"];

const a_7: AmongTable = [
    ["\u03B9\u03C3\u03B1", 1],
    ["\u03B9\u03C3\u03B1\u03BC\u03B5", 1],
    ["\u03B9\u03C3\u03B1\u03BD\u03B5", 1],
    ["\u03B9\u03C3\u03B5", 1],
    ["\u03B9\u03C3\u03B1\u03C4\u03B5", 1],
    ["\u03B9\u03C3\u03B1\u03BD", 1],
    ["\u03B9\u03C3\u03B5\u03C3", 1]
];

const a_8: AmongTable = [
    ["\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1", 1],
    ["\u03B5\u03C0\u03B1", 1],
    ["\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1", 1],
    ["\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1", 1],
    ["\u03B5\u03BC\u03C0\u03B1", 1],
    ["\u03C7\u03B1\u03C1\u03C4\u03BF\u03C0\u03B1", 1],
    ["\u03B5\u03BE\u03B1\u03C1\u03C7\u03B1", 1],
    ["\u03BA\u03BB\u03B5", 1],
    ["\u03B5\u03BA\u03BB\u03B5", 1, 1],
    ["\u03B1\u03C0\u03B5\u03BA\u03BB\u03B5", 1, 1],
    ["\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5", 1, 3],
    ["\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5", 1, 4],
    ["\u03B4\u03B1\u03BD\u03B5", 1],
    ["\u03C0\u03B5", 1],
    ["\u03B5\u03C0\u03B5", 1, 1],
    ["\u03BC\u03B5\u03C4\u03B5\u03C0\u03B5", 1, 1],
    ["\u03B5\u03C3\u03B5", 1],
    ["\u03B1\u03B8\u03C1\u03BF", 1],
    ["\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF", 1, 1]
];

const a_9: AmongTable = [
    ["\u03B9\u03C3\u03BF\u03C5\u03BC\u03B5", 1],
    ["\u03B9\u03C3\u03BF\u03C5\u03BD\u03B5", 1],
    ["\u03B9\u03C3\u03B5\u03C4\u03B5", 1],
    ["\u03B9\u03C3\u03B5\u03B9", 1],
    ["\u03B9\u03C3\u03BF\u03C5\u03BD", 1],
    ["\u03B9\u03C3\u03B5\u03B9\u03C3", 1],
    ["\u03B9\u03C3\u03C9", 1]
];

const a_10: AmongTable = [
    ["\u03B1\u03C4\u03B1", 2],
    ["\u03C6\u03B1", 2],
    ["\u03B7\u03C6\u03B1", 2, 1],
    ["\u03BC\u03B5\u03B3", 2],
    ["\u03BB\u03C5\u03B3", 2],
    ["\u03B7\u03B4", 2],
    ["\u03BA\u03BB\u03B5", 1],
    ["\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5", 1, 1],
    ["\u03C0\u03BB\u03B5", 1],
    ["\u03B4\u03B1\u03BD\u03B5", 1],
    ["\u03C3\u03B5", 1],
    ["\u03B1\u03C3\u03B5", 1, 1],
    ["\u03BA\u03B1\u03B8", 2],
    ["\u03B5\u03C7\u03B8", 2],
    ["\u03BA\u03B1\u03BA", 2],
    ["\u03BC\u03B1\u03BA", 2],
    ["\u03C3\u03BA", 2],
    ["\u03C6\u03B9\u03BB", 2],
    ["\u03BA\u03C5\u03BB", 2],
    ["\u03BC", 2],
    ["\u03B3\u03B5\u03BC", 2, 1],
    ["\u03B1\u03C7\u03BD", 2],
    ["\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF", 1],
    ["\u03C0", 2],
    ["\u03B1\u03C0", 2, 1],
    ["\u03B5\u03BC\u03C0", 2, 2],
    ["\u03B5\u03C5\u03C0", 2, 3],
    ["\u03B1\u03C1", 2],
    ["\u03B1\u03BF\u03C1", 2],
    ["\u03B3\u03C5\u03C1", 2],
    ["\u03C7\u03C1", 2],
    ["\u03C7\u03C9\u03C1", 2],
    ["\u03BA\u03C4", 2],
    ["\u03B1\u03BA\u03C4", 2, 1],
    ["\u03C7\u03C4", 2],
    ["\u03B1\u03C7\u03C4", 2, 1],
    ["\u03C4\u03B1\u03C7", 2],
    ["\u03C3\u03C7", 2],
    ["\u03B1\u03C3\u03C7", 2, 1],
    ["\u03C5\u03C8", 2]
];

const as_10: readonly string[] = ["\u03B9", "\u03B9\u03C3\u03C4"];

const a_11: AmongTable = [
    ["\u03B9\u03C3\u03C4\u03B1", 1],
    ["\u03B9\u03C3\u03C4\u03B5", 1],
    ["\u03B9\u03C3\u03C4\u03B7", 1],
    ["\u03B9\u03C3\u03C4\u03BF\u03B9", 1],
    ["\u03B9\u03C3\u03C4\u03C9\u03BD", 1],
    ["\u03B9\u03C3\u03C4\u03BF", 1],
    ["\u03B9\u03C3\u03C4\u03B5\u03C3", 1],
    ["\u03B9\u03C3\u03C4\u03B7\u03C3", 1],
    ["\u03B9\u03C3\u03C4\u03BF\u03C3", 1],
    ["\u03B9\u03C3\u03C4\u03BF\u03C5\u03C3", 1],
    ["\u03B9\u03C3\u03C4\u03BF\u03C5", 1]
];

const a_12: AmongTable = [
    ["\u03B5\u03B3\u03BA\u03BB\u03B5", 1],
    ["\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5", 1],
    ["\u03B4\u03B1\u03BD\u03B5", 2],
    ["\u03B1\u03BD\u03C4\u03B9\u03B4\u03B1\u03BD\u03B5", 2, 1],
    ["\u03C3\u03B5", 1],
    ["\u03BC\u03B5\u03C4\u03B1\u03C3\u03B5", 1, 1],
    ["\u03BC\u03B9\u03BA\u03C1\u03BF\u03C3\u03B5", 1, 2]
];

const as_12: readonly string[] = ["\u03B9\u03C3\u03BC", "\u03B9"];

const a_13: AmongTable = [
    ["\u03B1\u03C4\u03BF\u03BC\u03B9\u03BA", 2],
    ["\u03B5\u03B8\u03BD\u03B9\u03BA", 4],
    ["\u03C4\u03BF\u03C0\u03B9\u03BA", 7],
    ["\u03B5\u03BA\u03BB\u03B5\u03BA\u03C4\u03B9\u03BA", 5],
    ["\u03C3\u03BA\u03B5\u03C0\u03C4\u03B9\u03BA", 6],
    ["\u03B3\u03BD\u03C9\u03C3\u03C4\u03B9\u03BA", 3],
    ["\u03B1\u03B3\u03BD\u03C9\u03C3\u03C4\u03B9\u03BA", 1, 1],
    ["\u03B1\u03BB\u03B5\u03BE\u03B1\u03BD\u03B4\u03C1\u03B9\u03BD", 8],
    ["\u03B8\u03B5\u03B1\u03C4\u03C1\u03B9\u03BD", 10],
    ["\u03B2\u03C5\u03B6\u03B1\u03BD\u03C4\u03B9\u03BD", 9]
];

const as_13: readonly string[] = ["\u03B1\u03B3\u03BD\u03C9\u03C3\u03C4", "\u03B1\u03C4\u03BF\u03BC", "\u03B3\u03BD\u03C9\u03C3\u03C4", "\u03B5\u03B8\u03BD", "\u03B5\u03BA\u03BB\u03B5\u03BA\u03C4", "\u03C3\u03BA\u03B5\u03C0\u03C4", "\u03C4\u03BF\u03C0", "\u03B1\u03BB\u03B5\u03BE\u03B1\u03BD\u03B4\u03C1", "\u03B2\u03C5\u03B6\u03B1\u03BD\u03C4", "\u03B8\u03B5\u03B1\u03C4\u03C1"];

const a_14: AmongTable = [
    ["\u03B9\u03C3\u03BC\u03BF\u03B9", 1],
    ["\u03B9\u03C3\u03BC\u03C9\u03BD", 1],
    ["\u03B9\u03C3\u03BC\u03BF", 1],
    ["\u03B9\u03C3\u03BC\u03BF\u03C3", 1],
    ["\u03B9\u03C3\u03BC\u03BF\u03C5\u03C3", 1],
    ["\u03B9\u03C3\u03BC\u03BF\u03C5", 1]
];

const a_15: AmongTable = [
    ["\u03C3", 1],
    ["\u03C7", 1]
];

const a_16: AmongTable = [
    ["\u03BF\u03C5\u03B4\u03B1\u03BA\u03B9\u03B1", 1],
    ["\u03B1\u03C1\u03B1\u03BA\u03B9\u03B1", 1],
    ["\u03BF\u03C5\u03B4\u03B1\u03BA\u03B9", 1],
    ["\u03B1\u03C1\u03B1\u03BA\u03B9", 1]
];

const a_17: AmongTable = [
    ["\u03B2", 2],
    ["\u03B2\u03B1\u03BC\u03B2", 1, 1],
    ["\u03C3\u03BB\u03BF\u03B2", 1, 2],
    ["\u03C4\u03C3\u03B5\u03C7\u03BF\u03C3\u03BB\u03BF\u03B2", 1, 1],
    ["\u03BA\u03B1\u03C1\u03B4", 2],
    ["\u03B6", 2],
    ["\u03C4\u03B6", 1, 1],
    ["\u03BA", 1],
    ["\u03BA\u03B1\u03C0\u03B1\u03BA", 1, 1],
    ["\u03C3\u03BF\u03BA", 1, 2],
    ["\u03C3\u03BA", 1, 3],
    ["\u03B2\u03B1\u03BB", 2],
    ["\u03BC\u03B1\u03BB", 1],
    ["\u03B3\u03BB", 2],
    ["\u03C4\u03C1\u03B9\u03C0\u03BF\u03BB", 2],
    ["\u03C0\u03BB", 1],
    ["\u03BB\u03BF\u03C5\u03BB", 1],
    ["\u03C6\u03C5\u03BB", 1],
    ["\u03BA\u03B1\u03B9\u03BC", 1],
    ["\u03BA\u03BB\u03B9\u03BC", 1],
    ["\u03C6\u03B1\u03C1\u03BC", 1],
    ["\u03B3\u03B9\u03B1\u03BD", 2],
    ["\u03C3\u03C0\u03B1\u03BD", 1],
    ["\u03B7\u03B3\u03BF\u03C5\u03BC\u03B5\u03BD", 2],
    ["\u03BA\u03BF\u03BD", 1],
    ["\u03BC\u03B1\u03BA\u03C1\u03C5\u03BD", 2],
    ["\u03C0", 2],
    ["\u03BA\u03B1\u03C4\u03C1\u03B1\u03C0", 1, 1],
    ["\u03C1", 1],
    ["\u03B2\u03C1", 1, 1],
    ["\u03BB\u03B1\u03B2\u03C1", 1, 1],
    ["\u03B1\u03BC\u03B2\u03C1", 1, 2],
    ["\u03BC\u03B5\u03C1", 1, 4],
    ["\u03C0\u03B1\u03C4\u03B5\u03C1", 2, 5],
    ["\u03B1\u03BD\u03B8\u03C1", 1, 6],
    ["\u03BA\u03BF\u03C1", 1, 7],
    ["\u03C3", 1],
    ["\u03BD\u03B1\u03B3\u03BA\u03B1\u03C3", 1, 1],
    ["\u03C4\u03BF\u03C3", 2, 2],
    ["\u03BC\u03BF\u03C5\u03C3\u03C4", 1],
    ["\u03C1\u03C5", 1],
    ["\u03C6", 1],
    ["\u03C3\u03C6", 1, 1],
    ["\u03B1\u03BB\u03B9\u03C3\u03C6", 1, 1],
    ["\u03BD\u03C5\u03C6", 2, 3],
    ["\u03C7", 1]
];

const as_17: readonly string[] = ["\u03B1\u03BA", "\u03B9\u03C4\u03C3"];

const a_18: AmongTable = [
    ["\u03B1\u03BA\u03B9\u03B1", 1],
    ["\u03B1\u03C1\u03B1\u03BA\u03B9\u03B1", 1, 1],
    ["\u03B9\u03C4\u03C3\u03B1", 1],
    ["\u03B1\u03BA\u03B9", 1],
    ["\u03B1\u03C1\u03B1\u03BA\u03B9", 1, 1],
    ["\u03B9\u03C4\u03C3\u03C9\u03BD", 1],
    ["\u03B9\u03C4\u03C3\u03B1\u03C3", 1],
    ["\u03B9\u03C4\u03C3\u03B5\u03C3", 1]
];

const a_19: AmongTable = [
    ["\u03C8\u03B1\u03BB", 1],
    ["\u03B1\u03B9\u03C6\u03BD", 1],
    ["\u03BF\u03BB\u03BF", 1],
    ["\u03B9\u03C1", 1]
];

const a_20: AmongTable = [
    ["\u03B5", 1],
    ["\u03C0\u03B1\u03B9\u03C7\u03BD", 1]
];

const a_21: AmongTable = [
    ["\u03B9\u03B4\u03B9\u03B1", 1],
    ["\u03B9\u03B4\u03B9\u03C9\u03BD", 1],
    ["\u03B9\u03B4\u03B9\u03BF", 1]
];

const a_22: AmongTable = [
    ["\u03B9\u03B2", 1],
    ["\u03B4", 1],
    ["\u03C6\u03C1\u03B1\u03B3\u03BA", 1],
    ["\u03BB\u03C5\u03BA", 1],
    ["\u03BF\u03B2\u03B5\u03BB", 1],
    ["\u03BC\u03B7\u03BD", 1],
    ["\u03C1", 1]
];

const a_23: AmongTable = [
    ["\u03B9\u03C3\u03BA\u03B5", 1],
    ["\u03B9\u03C3\u03BA\u03BF", 1],
    ["\u03B9\u03C3\u03BA\u03BF\u03C3", 1],
    ["\u03B9\u03C3\u03BA\u03BF\u03C5", 1]
];

const a_24: AmongTable = [
    ["\u03B1\u03B4\u03C9\u03BD", 1],
    ["\u03B1\u03B4\u03B5\u03C3", 1]
];

const a_25: AmongTable = [
    ["\u03B3\u03B9\u03B1\u03B3\u03B9", -1],
    ["\u03B8\u03B5\u03B9", -1],
    ["\u03BF\u03BA", -1],
    ["\u03BC\u03B1\u03BC", -1],
    ["\u03BC\u03B1\u03BD", -1],
    ["\u03BC\u03C0\u03B1\u03BC\u03C0", -1],
    ["\u03C0\u03B5\u03B8\u03B5\u03C1", -1],
    ["\u03C0\u03B1\u03C4\u03B5\u03C1", -1],
    ["\u03BA\u03C5\u03C1", -1],
    ["\u03BD\u03C4\u03B1\u03BD\u03C4", -1]
];

const a_26: AmongTable = [
    ["\u03B5\u03B4\u03C9\u03BD", 1],
    ["\u03B5\u03B4\u03B5\u03C3", 1]
];

const a_27: AmongTable = [
    ["\u03BC\u03B9\u03BB", 1],
    ["\u03B4\u03B1\u03C0", 1],
    ["\u03B3\u03B7\u03C0", 1],
    ["\u03B9\u03C0", 1],
    ["\u03B5\u03BC\u03C0", 1],
    ["\u03BF\u03C0", 1],
    ["\u03BA\u03C1\u03B1\u03C3\u03C0", 1],
    ["\u03C5\u03C0", 1]
];

const a_28: AmongTable = [
    ["\u03BF\u03C5\u03B4\u03C9\u03BD", 1],
    ["\u03BF\u03C5\u03B4\u03B5\u03C3", 1]
];

const a_29: AmongTable = [
    ["\u03C4\u03C1\u03B1\u03B3", 1],
    ["\u03C6\u03B5", 1],
    ["\u03BA\u03B1\u03BB\u03B9\u03B1\u03BA", 1],
    ["\u03B1\u03C1\u03BA", 1],
    ["\u03C3\u03BA", 1],
    ["\u03C0\u03B5\u03C4\u03B1\u03BB", 1],
    ["\u03B2\u03B5\u03BB", 1],
    ["\u03BB\u03BF\u03C5\u03BB", 1],
    ["\u03C6\u03BB", 1],
    ["\u03C7\u03BD", 1],
    ["\u03C0\u03BB\u03B5\u03BE", 1],
    ["\u03C3\u03C0", 1],
    ["\u03C6\u03C1", 1],
    ["\u03C3", 1],
    ["\u03BB\u03B9\u03C7", 1]
];

const a_30: AmongTable = [
    ["\u03B5\u03C9\u03BD", 1],
    ["\u03B5\u03C9\u03C3", 1]
];

const a_31: AmongTable = [
    ["\u03B4", 1],
    ["\u03B9\u03B4", 1, 1],
    ["\u03B8", 1],
    ["\u03B3\u03B1\u03BB", 1],
    ["\u03B5\u03BB", 1],
    ["\u03BD", 1],
    ["\u03C0", 1],
    ["\u03C0\u03B1\u03C1", 1]
];

const a_32: AmongTable = [
    ["\u03B9\u03B1", 1],
    ["\u03B9\u03C9\u03BD", 1],
    ["\u03B9\u03BF\u03C5", 1]
];

const a_33: AmongTable = [
    ["\u03B9\u03BA\u03B1", 1],
    ["\u03B9\u03BA\u03C9\u03BD", 1],
    ["\u03B9\u03BA\u03BF", 1],
    ["\u03B9\u03BA\u03BF\u03C5", 1]
];

const a_34: AmongTable = [
    ["\u03B1\u03B4", 1],
    ["\u03C3\u03C5\u03BD\u03B1\u03B4", 1, 1],
    ["\u03BA\u03B1\u03C4\u03B1\u03B4", 1, 2],
    ["\u03B1\u03BD\u03C4\u03B9\u03B4", 1],
    ["\u03B5\u03BD\u03B4", 1],
    ["\u03C6\u03C5\u03BB\u03BF\u03B4", 1],
    ["\u03C5\u03C0\u03BF\u03B4", 1],
    ["\u03C0\u03C1\u03C9\u03C4\u03BF\u03B4", 1],
    ["\u03B5\u03BE\u03C9\u03B4", 1],
    ["\u03B7\u03B8", 1],
    ["\u03B1\u03BD\u03B7\u03B8", 1, 1],
    ["\u03BE\u03B9\u03BA", 1],
    ["\u03B1\u03BB", 1],
    ["\u03B1\u03BC\u03BC\u03BF\u03C7\u03B1\u03BB", 1, 1],
    ["\u03C3\u03C5\u03BD\u03BF\u03BC\u03B7\u03BB", 1],
    ["\u03BC\u03C0\u03BF\u03BB", 1],
    ["\u03BC\u03BF\u03C5\u03BB", 1],
    ["\u03C4\u03C3\u03B1\u03BC", 1],
    ["\u03B2\u03C1\u03C9\u03BC", 1],
    ["\u03B1\u03BC\u03B1\u03BD", 1],
    ["\u03BC\u03C0\u03B1\u03BD", 1],
    ["\u03BA\u03B1\u03BB\u03BB\u03B9\u03BD", 1],
    ["\u03C0\u03BF\u03C3\u03C4\u03B5\u03BB\u03BD", 1],
    ["\u03C6\u03B9\u03BB\u03BF\u03BD", 1],
    ["\u03BA\u03B1\u03BB\u03C0", 1],
    ["\u03B3\u03B5\u03C1", 1],
    ["\u03C7\u03B1\u03C3", 1],
    ["\u03BC\u03C0\u03BF\u03C3", 1],
    ["\u03C0\u03BB\u03B9\u03B1\u03C4\u03C3", 1],
    ["\u03C0\u03B5\u03C4\u03C3", 1],
    ["\u03C0\u03B9\u03C4\u03C3", 1],
    ["\u03C6\u03C5\u03C3", 1],
    ["\u03BC\u03C0\u03B1\u03B3\u03B9\u03B1\u03C4", 1],
    ["\u03BD\u03B9\u03C4", 1],
    ["\u03C0\u03B9\u03BA\u03B1\u03BD\u03C4", 1],
    ["\u03C3\u03B5\u03C1\u03C4", 1]
];

const a_35: AmongTable = [
    ["\u03B1\u03B3\u03B1\u03BC\u03B5", 1],
    ["\u03B7\u03BA\u03B1\u03BC\u03B5", 1],
    ["\u03B7\u03B8\u03B7\u03BA\u03B1\u03BC\u03B5", 1, 1],
    ["\u03B7\u03C3\u03B1\u03BC\u03B5", 1],
    ["\u03BF\u03C5\u03C3\u03B1\u03BC\u03B5", 1]
];

const a_36: AmongTable = [
    ["\u03B2\u03BF\u03C5\u03B2", 1],
    ["\u03BE\u03B5\u03B8", 1],
    ["\u03C0\u03B5\u03B8", 1],
    ["\u03B1\u03C0\u03BF\u03B8", 1],
    ["\u03B1\u03C0\u03BF\u03BA", 1],
    ["\u03BF\u03C5\u03BB", 1],
    ["\u03B1\u03BD\u03B1\u03C0", 1],
    ["\u03C0\u03B9\u03BA\u03C1", 1],
    ["\u03C0\u03BF\u03C4", 1],
    ["\u03B1\u03C0\u03BF\u03C3\u03C4", 1],
    ["\u03C7", 1],
    ["\u03C3\u03B9\u03C7", 1, 1]
];

const a_37: AmongTable = [
    ["\u03C4\u03C1", 1],
    ["\u03C4\u03C3", 1]
];

const a_38: AmongTable = [
    ["\u03B1\u03B3\u03B1\u03BD\u03B5", 1],
    ["\u03B7\u03BA\u03B1\u03BD\u03B5", 1],
    ["\u03B7\u03B8\u03B7\u03BA\u03B1\u03BD\u03B5", 1, 1],
    ["\u03B7\u03C3\u03B1\u03BD\u03B5", 1],
    ["\u03BF\u03C5\u03C3\u03B1\u03BD\u03B5", 1],
    ["\u03BF\u03BD\u03C4\u03B1\u03BD\u03B5", 1],
    ["\u03B9\u03BF\u03BD\u03C4\u03B1\u03BD\u03B5", 1, 1],
    ["\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD\u03B5", 1],
    ["\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD\u03B5", 1, 1],
    ["\u03BF\u03C4\u03B1\u03BD\u03B5", 1],
    ["\u03B9\u03BF\u03C4\u03B1\u03BD\u03B5", 1, 1]
];

const a_39: AmongTable = [
    ["\u03C4\u03B1\u03B2", 1],
    ["\u03BD\u03C4\u03B1\u03B2", 1, 1],
    ["\u03C8\u03B7\u03BB\u03BF\u03C4\u03B1\u03B2", 1, 2],
    ["\u03BB\u03B9\u03B2", 1],
    ["\u03BA\u03BB\u03B9\u03B2", 1, 1],
    ["\u03BE\u03B7\u03C1\u03BF\u03BA\u03BB\u03B9\u03B2", 1, 1],
    ["\u03B3", 1],
    ["\u03B1\u03B3", 1, 1],
    ["\u03C4\u03C1\u03B1\u03B3", 1, 1],
    ["\u03C4\u03C3\u03B1\u03B3", 1, 2],
    ["\u03B1\u03B8\u03B9\u03B3\u03B3", 1, 4],
    ["\u03C4\u03C3\u03B9\u03B3\u03B3", 1, 5],
    ["\u03B1\u03C4\u03C3\u03B9\u03B3\u03B3", 1, 1],
    ["\u03C3\u03C4\u03B5\u03B3", 1, 7],
    ["\u03B1\u03C0\u03B7\u03B3", 1, 8],
    ["\u03C3\u03B9\u03B3", 1, 9],
    ["\u03B1\u03BD\u03BF\u03C1\u03B3", 1, 10],
    ["\u03B5\u03BD\u03BF\u03C1\u03B3", 1, 11],
    ["\u03BA\u03B1\u03BB\u03C0\u03BF\u03C5\u03B6", 1],
    ["\u03B8", 1],
    ["\u03BC\u03C9\u03B1\u03BC\u03B5\u03B8", 1, 1],
    ["\u03C0\u03B9\u03B8", 1, 2],
    ["\u03B1\u03C0\u03B9\u03B8", 1, 1],
    ["\u03B4\u03B5\u03BA", 1],
    ["\u03C0\u03B5\u03BB\u03B5\u03BA", 1],
    ["\u03B9\u03BA", 1],
    ["\u03B1\u03BD\u03B9\u03BA", 1, 1],
    ["\u03B2\u03BF\u03C5\u03BB\u03BA", 1],
    ["\u03B2\u03B1\u03C3\u03BA", 1],
    ["\u03B2\u03C1\u03B1\u03C7\u03C5\u03BA", 1],
    ["\u03B3\u03B1\u03BB", 1],
    ["\u03BA\u03B1\u03C4\u03B1\u03B3\u03B1\u03BB", 1, 1],
    ["\u03BF\u03BB\u03BF\u03B3\u03B1\u03BB", 1, 2],
    ["\u03B2\u03B1\u03B8\u03C5\u03B3\u03B1\u03BB", 1, 3],
    ["\u03BC\u03B5\u03BB", 1],
    ["\u03BA\u03B1\u03C3\u03C4\u03B5\u03BB", 1],
    ["\u03C0\u03BF\u03C1\u03C4\u03BF\u03BB", 1],
    ["\u03C0\u03BB", 1],
    ["\u03B4\u03B9\u03C0\u03BB", 1, 1],
    ["\u03BB\u03B1\u03BF\u03C0\u03BB", 1, 2],
    ["\u03C8\u03C5\u03C7\u03BF\u03C0\u03BB", 1, 3],
    ["\u03BF\u03C5\u03BB", 1],
    ["\u03BC", 1],
    ["\u03BF\u03BB\u03B9\u03B3\u03BF\u03B4\u03B1\u03BC", 1, 1],
    ["\u03BC\u03BF\u03C5\u03C3\u03BF\u03C5\u03BB\u03BC", 1, 2],
    ["\u03B4\u03C1\u03B1\u03B4\u03BF\u03C5\u03BC", 1, 3],
    ["\u03B2\u03C1\u03B1\u03C7\u03BC", 1, 4],
    ["\u03BD", 1],
    ["\u03B1\u03BC\u03B5\u03C1\u03B9\u03BA\u03B1\u03BD", 1, 1],
    ["\u03C0", 1],
    ["\u03B1\u03B4\u03B1\u03C0", 1, 1],
    ["\u03C7\u03B1\u03BC\u03B7\u03BB\u03BF\u03B4\u03B1\u03C0", 1, 2],
    ["\u03C0\u03BF\u03BB\u03C5\u03B4\u03B1\u03C0", 1, 3],
    ["\u03BA\u03BF\u03C0", 1, 4],
    ["\u03C5\u03C0\u03BF\u03BA\u03BF\u03C0", 1, 1],
    ["\u03C4\u03C3\u03BF\u03C0", 1, 6],
    ["\u03C3\u03C0", 1, 7],
    ["\u03B5\u03C1", 1],
    ["\u03B3\u03B5\u03C1", 1, 1],
    ["\u03B2\u03B5\u03C4\u03B5\u03C1", 1, 2],
    ["\u03BB\u03BF\u03C5\u03B8\u03B7\u03C1", 1],
    ["\u03BA\u03BF\u03C1\u03BC\u03BF\u03C1", 1],
    ["\u03C0\u03B5\u03C1\u03B9\u03C4\u03C1", 1],
    ["\u03BF\u03C5\u03C1", 1],
    ["\u03C3", 1],
    ["\u03B2\u03B1\u03C3", 1, 1],
    ["\u03C0\u03BF\u03BB\u03B9\u03C3", 1, 2],
    ["\u03C3\u03B1\u03C1\u03B1\u03BA\u03B1\u03C4\u03C3", 1, 3],
    ["\u03B8\u03C5\u03C3", 1, 4],
    ["\u03B4\u03B9\u03B1\u03C4", 1],
    ["\u03C0\u03BB\u03B1\u03C4", 1],
    ["\u03C4\u03C3\u03B1\u03C1\u03BB\u03B1\u03C4", 1],
    ["\u03C4\u03B5\u03C4", 1],
    ["\u03C0\u03BF\u03C5\u03C1\u03B9\u03C4", 1],
    ["\u03C3\u03BF\u03C5\u03BB\u03C4", 1],
    ["\u03BC\u03B1\u03B9\u03BD\u03C4", 1],
    ["\u03B6\u03C9\u03BD\u03C4", 1],
    ["\u03BA\u03B1\u03C3\u03C4", 1],
    ["\u03C6", 1],
    ["\u03B4\u03B9\u03B1\u03C6", 1, 1],
    ["\u03C3\u03C4\u03B5\u03C6", 1, 2],
    ["\u03C6\u03C9\u03C4\u03BF\u03C3\u03C4\u03B5\u03C6", 1, 1],
    ["\u03C0\u03B5\u03C1\u03B7\u03C6", 1, 4],
    ["\u03C5\u03C0\u03B5\u03C1\u03B7\u03C6", 1, 1],
    ["\u03BA\u03BF\u03B9\u03BB\u03B1\u03C1\u03C6", 1, 6],
    ["\u03C0\u03B5\u03BD\u03C4\u03B1\u03C1\u03C6", 1, 7],
    ["\u03BF\u03C1\u03C6", 1, 8],
    ["\u03C7", 1],
    ["\u03B1\u03BC\u03B7\u03C7", 1, 1],
    ["\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7", 1, 2],
    ["\u03BC\u03B5\u03B3\u03BB\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7", 1, 1],
    ["\u03BA\u03B1\u03C0\u03BD\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7", 1, 2],
    ["\u03BC\u03B9\u03BA\u03C1\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7", 1, 3],
    ["\u03C0\u03BF\u03BB\u03C5\u03BC\u03B7\u03C7", 1, 6],
    ["\u03BB\u03B9\u03C7", 1, 7]
];

const a_40: AmongTable = [
    ["\u03B5\u03BD\u03B4", 1],
    ["\u03C3\u03C5\u03BD\u03B4", 1],
    ["\u03BF\u03B4", 1],
    ["\u03B4\u03B9\u03B1\u03B8", 1],
    ["\u03BA\u03B1\u03B8", 1],
    ["\u03C1\u03B1\u03B8", 1],
    ["\u03C4\u03B1\u03B8", 1],
    ["\u03C4\u03B9\u03B8", 1],
    ["\u03B5\u03BA\u03B8", 1],
    ["\u03B5\u03BD\u03B8", 1],
    ["\u03C3\u03C5\u03BD\u03B8", 1],
    ["\u03C1\u03BF\u03B8", 1],
    ["\u03C5\u03C0\u03B5\u03C1\u03B8", 1],
    ["\u03C3\u03B8", 1],
    ["\u03B5\u03C5\u03B8", 1],
    ["\u03B1\u03C1\u03BA", 1],
    ["\u03C9\u03C6\u03B5\u03BB", 1],
    ["\u03B2\u03BF\u03BB", 1],
    ["\u03B1\u03B9\u03BD", 1],
    ["\u03C0\u03BF\u03BD", 1],
    ["\u03C1\u03BF\u03BD", 1],
    ["\u03C3\u03C5\u03BD", 1],
    ["\u03B2\u03B1\u03C1", 1],
    ["\u03B2\u03C1", 1],
    ["\u03B1\u03B9\u03C1", 1],
    ["\u03C6\u03BF\u03C1", 1],
    ["\u03B5\u03C5\u03C1", 1],
    ["\u03C0\u03C5\u03C1", 1],
    ["\u03C7\u03C9\u03C1", 1],
    ["\u03BD\u03B5\u03C4", 1],
    ["\u03C3\u03C7", 1]
];

const a_41: AmongTable = [
    ["\u03C0\u03B1\u03B3", 1],
    ["\u03B4", 1],
    ["\u03B1\u03B4", 1, 1],
    ["\u03B8", 1],
    ["\u03B1\u03B8", 1, 1],
    ["\u03C4\u03BF\u03BA", 1],
    ["\u03C3\u03BA", 1],
    ["\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03BB", 1],
    ["\u03C3\u03BA\u03B5\u03BB", 1],
    ["\u03B1\u03C0\u03BB", 1],
    ["\u03B5\u03BC", 1],
    ["\u03B1\u03BD", 1],
    ["\u03B2\u03B5\u03BD", 1],
    ["\u03B2\u03B1\u03C1\u03BF\u03BD", 1],
    ["\u03BA\u03BF\u03C0", 1],
    ["\u03C3\u03B5\u03C1\u03C0", 1],
    ["\u03B1\u03B2\u03B1\u03C1", 1],
    ["\u03B5\u03BD\u03B1\u03C1", 1],
    ["\u03B1\u03B2\u03C1", 1],
    ["\u03BC\u03C0\u03BF\u03C1", 1],
    ["\u03B8\u03B1\u03C1\u03C1", 1],
    ["\u03BD\u03C4\u03C1", 1],
    ["\u03C5", 1],
    ["\u03BD\u03B9\u03C6", 1],
    ["\u03C3\u03C5\u03C1\u03C6", 1]
];

const a_42: AmongTable = [
    ["\u03BF\u03BD\u03C4\u03B1\u03C3", 1],
    ["\u03C9\u03BD\u03C4\u03B1\u03C3", 1]
];

const a_43: AmongTable = [
    ["\u03BF\u03BC\u03B1\u03C3\u03C4\u03B5", 1],
    ["\u03B9\u03BF\u03BC\u03B1\u03C3\u03C4\u03B5", 1, 1]
];

const a_44: AmongTable = [
    ["\u03C0", 1],
    ["\u03B1\u03C0", 1, 1],
    ["\u03B1\u03BA\u03B1\u03C4\u03B1\u03C0", 1, 1],
    ["\u03C3\u03C5\u03BC\u03C0", 1, 3],
    ["\u03B1\u03C3\u03C5\u03BC\u03C0", 1, 1],
    ["\u03B1\u03BC\u03B5\u03C4\u03B1\u03BC\u03C6", 1]
];

const a_45: AmongTable = [
    ["\u03B6", 1],
    ["\u03B1\u03BB", 1],
    ["\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03BB", 1, 1],
    ["\u03B5\u03BA\u03C4\u03B5\u03BB", 1],
    ["\u03BC", 1],
    ["\u03BE", 1],
    ["\u03C0\u03C1\u03BF", 1],
    ["\u03B1\u03C1", 1],
    ["\u03BD\u03B9\u03C3", 1]
];

const a_46: AmongTable = [
    ["\u03B7\u03B8\u03B7\u03BA\u03B1", 1],
    ["\u03B7\u03B8\u03B7\u03BA\u03B5", 1],
    ["\u03B7\u03B8\u03B7\u03BA\u03B5\u03C3", 1]
];

const a_47: AmongTable = [
    ["\u03C0\u03B9\u03B8", 1],
    ["\u03BF\u03B8", 1],
    ["\u03BD\u03B1\u03C1\u03B8", 1],
    ["\u03C3\u03BA\u03BF\u03C5\u03BB", 1],
    ["\u03C3\u03BA\u03C9\u03BB", 1],
    ["\u03C3\u03C6", 1]
];

const a_48: AmongTable = [
    ["\u03B8", 1],
    ["\u03B4\u03B9\u03B1\u03B8", 1, 1],
    ["\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03C4\u03B1\u03B8", 1, 2],
    ["\u03C3\u03C5\u03BD\u03B8", 1, 3],
    ["\u03C0\u03C1\u03BF\u03C3\u03B8", 1, 4]
];

const a_49: AmongTable = [
    ["\u03B7\u03BA\u03B1", 1],
    ["\u03B7\u03BA\u03B5", 1],
    ["\u03B7\u03BA\u03B5\u03C3", 1]
];

const a_50: AmongTable = [
    ["\u03C6\u03B1\u03B3", 1],
    ["\u03BB\u03B7\u03B3", 1],
    ["\u03C6\u03C1\u03C5\u03B4", 1],
    ["\u03BC\u03B1\u03BD\u03C4\u03B9\u03BB", 1],
    ["\u03BC\u03B1\u03BB\u03BB", 1],
    ["\u03BF\u03BC", 1],
    ["\u03B2\u03BB\u03B5\u03C0", 1],
    ["\u03C0\u03BF\u03B4\u03B1\u03C1", 1],
    ["\u03BA\u03C5\u03BC\u03B1\u03C4", 1],
    ["\u03C0\u03C1\u03C9\u03C4", 1],
    ["\u03BB\u03B1\u03C7", 1],
    ["\u03C0\u03B1\u03BD\u03C4\u03B1\u03C7", 1]
];

const a_51: AmongTable = [
    ["\u03C4\u03C3\u03B1", 1],
    ["\u03C7\u03B1\u03B4", 1],
    ["\u03BC\u03B5\u03B4", 1],
    ["\u03BB\u03B1\u03BC\u03C0\u03B9\u03B4", 1],
    ["\u03B4\u03B5", 1],
    ["\u03C0\u03BB\u03B5", 1],
    ["\u03BC\u03B5\u03C3\u03B1\u03B6", 1],
    ["\u03B4\u03B5\u03C3\u03C0\u03BF\u03B6", 1],
    ["\u03B1\u03B9\u03B8", 1],
    ["\u03C6\u03B1\u03C1\u03BC\u03B1\u03BA", 1],
    ["\u03B1\u03B3\u03BA", 1],
    ["\u03B1\u03BD\u03B7\u03BA", 1],
    ["\u03BB", 1],
    ["\u03BC", 1],
    ["\u03B1\u03BC", 1, 1],
    ["\u03B2\u03C1\u03BF\u03BC", 1, 2],
    ["\u03C5\u03C0\u03BF\u03C4\u03B5\u03B9\u03BD", 1],
    ["\u03B5\u03BA\u03BB\u03B9\u03C0", 1],
    ["\u03C1", 1],
    ["\u03B5\u03BD\u03B4\u03B9\u03B1\u03C6\u03B5\u03C1", 1, 1],
    ["\u03B1\u03BD\u03B1\u03C1\u03C1", 1, 2],
    ["\u03C0\u03B1\u03C4", 1],
    ["\u03BA\u03B1\u03B8\u03B1\u03C1\u03B5\u03C5", 1],
    ["\u03B4\u03B5\u03C5\u03C4\u03B5\u03C1\u03B5\u03C5", 1],
    ["\u03BB\u03B5\u03C7", 1]
];

const a_52: AmongTable = [
    ["\u03BF\u03C5\u03C3\u03B1", 1],
    ["\u03BF\u03C5\u03C3\u03B5", 1],
    ["\u03BF\u03C5\u03C3\u03B5\u03C3", 1]
];

const a_53: AmongTable = [
    ["\u03C0\u03B5\u03BB", 1],
    ["\u03BB\u03BB", 1],
    ["\u03C3\u03BC\u03B7\u03BD", 1],
    ["\u03C1\u03C0", 1],
    ["\u03C0\u03C1", 1],
    ["\u03C6\u03C1", 1],
    ["\u03C7\u03BF\u03C1\u03C4", 1],
    ["\u03BF\u03C6", 1],
    ["\u03C8\u03BF\u03C6", -1, 1],
    ["\u03C3\u03C6", 1],
    ["\u03BB\u03BF\u03C7", 1],
    ["\u03BD\u03B1\u03C5\u03BB\u03BF\u03C7", -1, 1]
];

const a_54: AmongTable = [
    ["\u03B1\u03BC\u03B1\u03BB\u03BB\u03B9", 1],
    ["\u03BB", 1],
    ["\u03B1\u03BC\u03B1\u03BB", 1, 1],
    ["\u03BC", 1],
    ["\u03BF\u03C5\u03BB\u03B1\u03BC", 1, 1],
    ["\u03B5\u03BD", 1],
    ["\u03B4\u03B5\u03C1\u03B2\u03B5\u03BD", 1, 1],
    ["\u03C0", 1],
    ["\u03B1\u03B5\u03B9\u03C0", 1, 1],
    ["\u03B1\u03C1\u03C4\u03B9\u03C0", 1, 2],
    ["\u03C3\u03C5\u03BC\u03C0", 1, 3],
    ["\u03BD\u03B5\u03BF\u03C0", 1, 4],
    ["\u03BA\u03C1\u03BF\u03BA\u03B1\u03BB\u03BF\u03C0", 1, 5],
    ["\u03BF\u03BB\u03BF\u03C0", 1, 6],
    ["\u03C0\u03C1\u03BF\u03C3\u03C9\u03C0\u03BF\u03C0", 1, 7],
    ["\u03C3\u03B9\u03B4\u03B7\u03C1\u03BF\u03C0", 1, 8],
    ["\u03B4\u03C1\u03BF\u03C3\u03BF\u03C0", 1, 9],
    ["\u03B1\u03C3\u03C0", 1, 10],
    ["\u03B1\u03BD\u03C5\u03C0", 1, 11],
    ["\u03C1", 1],
    ["\u03B1\u03C3\u03C0\u03B1\u03C1", 1, 1],
    ["\u03C7\u03B1\u03C1", 1, 2],
    ["\u03B1\u03C7\u03B1\u03C1", 1, 1],
    ["\u03B1\u03C0\u03B5\u03C1", 1, 4],
    ["\u03C4\u03C1", 1, 5],
    ["\u03BF\u03C5\u03C1", 1, 6],
    ["\u03C4", 1],
    ["\u03B4\u03B9\u03B1\u03C4", 1, 1],
    ["\u03B5\u03C0\u03B9\u03C4", 1, 2],
    ["\u03C3\u03C5\u03BD\u03C4", 1, 3],
    ["\u03BF\u03BC\u03BF\u03C4", 1, 4],
    ["\u03BD\u03BF\u03BC\u03BF\u03C4", 1, 1],
    ["\u03B1\u03C0\u03BF\u03C4", 1, 6],
    ["\u03C5\u03C0\u03BF\u03C4", 1, 7],
    ["\u03B1\u03B2\u03B1\u03C3\u03C4", 1, 8],
    ["\u03B1\u03B9\u03BC\u03BF\u03C3\u03C4", 1, 9],
    ["\u03C0\u03C1\u03BF\u03C3\u03C4", 1, 10],
    ["\u03B1\u03BD\u03C5\u03C3\u03C4", 1, 11],
    ["\u03BD\u03B1\u03C5", 1],
    ["\u03B1\u03C6", 1],
    ["\u03BE\u03B5\u03C6", 1],
    ["\u03B1\u03B4\u03B7\u03C6", 1],
    ["\u03C0\u03B1\u03BC\u03C6", 1],
    ["\u03C0\u03BF\u03BB\u03C5\u03C6", 1]
];

const a_55: AmongTable = [
    ["\u03B1\u03B3\u03B1", 1],
    ["\u03B1\u03B3\u03B5", 1],
    ["\u03B1\u03B3\u03B5\u03C3", 1]
];

const a_56: AmongTable = [
    ["\u03B7\u03C3\u03B1", 1],
    ["\u03B7\u03C3\u03B5", 1],
    ["\u03B7\u03C3\u03BF\u03C5", 1]
];

const a_57: AmongTable = [
    ["\u03BD", 1],
    ["\u03B4\u03C9\u03B4\u03B5\u03BA\u03B1\u03BD", 1, 1],
    ["\u03B5\u03C0\u03C4\u03B1\u03BD", 1, 2],
    ["\u03BC\u03B5\u03B3\u03B1\u03BB\u03BF\u03BD", 1, 3],
    ["\u03B5\u03C1\u03B7\u03BC\u03BF\u03BD", 1, 4],
    ["\u03C7\u03B5\u03C1\u03C3\u03BF\u03BD", 1, 5]
];

const a_58: AmongTable = [
    ["\u03C3\u03B2", 1],
    ["\u03B1\u03C3\u03B2", 1, 1],
    ["\u03B1\u03C0\u03BB", 1],
    ["\u03B1\u03B5\u03B9\u03BC\u03BD", 1],
    ["\u03C7\u03C1", 1],
    ["\u03B1\u03C7\u03C1", 1, 1],
    ["\u03BA\u03BF\u03B9\u03BD\u03BF\u03C7\u03C1", 1, 2],
    ["\u03B4\u03C5\u03C3\u03C7\u03C1", 1, 3],
    ["\u03B5\u03C5\u03C7\u03C1", 1, 4],
    ["\u03C0\u03B1\u03BB\u03B9\u03BC\u03C8", 1]
];

const a_59: AmongTable = [
    ["\u03BF\u03C5\u03BD\u03B5", 1],
    ["\u03B7\u03B8\u03BF\u03C5\u03BD\u03B5", 1, 1],
    ["\u03B7\u03C3\u03BF\u03C5\u03BD\u03B5", 1, 2]
];

const a_60: AmongTable = [
    ["\u03C3\u03C0\u03B9", 1],
    ["\u03BD", 1],
    ["\u03B5\u03BE\u03C9\u03BD", 1, 1],
    ["\u03C1", 1],
    ["\u03C3\u03C4\u03C1\u03B1\u03B2\u03BF\u03BC\u03BF\u03C5\u03C4\u03C3", 1],
    ["\u03BA\u03B1\u03BA\u03BF\u03BC\u03BF\u03C5\u03C4\u03C3", 1]
];

const a_61: AmongTable = [
    ["\u03BF\u03C5\u03BC\u03B5", 1],
    ["\u03B7\u03B8\u03BF\u03C5\u03BC\u03B5", 1, 1],
    ["\u03B7\u03C3\u03BF\u03C5\u03BC\u03B5", 1, 2]
];

const a_62: AmongTable = [
    ["\u03B1\u03B6", 1],
    ["\u03C9\u03C1\u03B9\u03BF\u03C0\u03BB", 1],
    ["\u03B1\u03C3\u03BF\u03C5\u03C3", 1],
    ["\u03C0\u03B1\u03C1\u03B1\u03C3\u03BF\u03C5\u03C3", 1, 1],
    ["\u03B1\u03BB\u03BB\u03BF\u03C3\u03BF\u03C5\u03C3", 1],
    ["\u03C6", 1],
    ["\u03C7", 1]
];

const a_63: AmongTable = [
    ["\u03BC\u03B1\u03C4\u03B1", 1],
    ["\u03BC\u03B1\u03C4\u03C9\u03BD", 1],
    ["\u03BC\u03B1\u03C4\u03BF\u03C3", 1]
];

const a_64: AmongTable = [
    ["\u03B1", 1],
    ["\u03B9\u03BF\u03C5\u03BC\u03B1", 1, 1],
    ["\u03BF\u03BC\u03BF\u03C5\u03BD\u03B1", 1, 2],
    ["\u03B9\u03BF\u03BC\u03BF\u03C5\u03BD\u03B1", 1, 1],
    ["\u03BF\u03C3\u03BF\u03C5\u03BD\u03B1", 1, 4],
    ["\u03B9\u03BF\u03C3\u03BF\u03C5\u03BD\u03B1", 1, 1],
    ["\u03B5", 1],
    ["\u03B1\u03B3\u03B1\u03C4\u03B5", 1, 1],
    ["\u03B7\u03BA\u03B1\u03C4\u03B5", 1, 2],
    ["\u03B7\u03B8\u03B7\u03BA\u03B1\u03C4\u03B5", 1, 1],
    ["\u03B7\u03C3\u03B1\u03C4\u03B5", 1, 4],
    ["\u03BF\u03C5\u03C3\u03B1\u03C4\u03B5", 1, 5],
    ["\u03B5\u03B9\u03C4\u03B5", 1, 6],
    ["\u03B7\u03B8\u03B5\u03B9\u03C4\u03B5", 1, 1],
    ["\u03B9\u03B5\u03BC\u03B1\u03C3\u03C4\u03B5", 1, 8],
    ["\u03BF\u03C5\u03BC\u03B1\u03C3\u03C4\u03B5", 1, 9],
    ["\u03B9\u03BF\u03C5\u03BC\u03B1\u03C3\u03C4\u03B5", 1, 1],
    ["\u03B9\u03B5\u03C3\u03B1\u03C3\u03C4\u03B5", 1, 11],
    ["\u03BF\u03C3\u03B1\u03C3\u03C4\u03B5", 1, 12],
    ["\u03B9\u03BF\u03C3\u03B1\u03C3\u03C4\u03B5", 1, 1],
    ["\u03B7", 1],
    ["\u03B9", 1],
    ["\u03B1\u03BC\u03B1\u03B9", 1, 1],
    ["\u03B9\u03B5\u03BC\u03B1\u03B9", 1, 2],
    ["\u03BF\u03BC\u03B1\u03B9", 1, 3],
    ["\u03BF\u03C5\u03BC\u03B1\u03B9", 1, 4],
    ["\u03B1\u03C3\u03B1\u03B9", 1, 5],
    ["\u03B5\u03C3\u03B1\u03B9", 1, 6],
    ["\u03B9\u03B5\u03C3\u03B1\u03B9", 1, 1],
    ["\u03B1\u03C4\u03B1\u03B9", 1, 8],
    ["\u03B5\u03C4\u03B1\u03B9", 1, 9],
    ["\u03B9\u03B5\u03C4\u03B1\u03B9", 1, 1],
    ["\u03BF\u03BD\u03C4\u03B1\u03B9", 1, 11],
    ["\u03BF\u03C5\u03BD\u03C4\u03B1\u03B9", 1, 12],
    ["\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03B9", 1, 1],
    ["\u03B5\u03B9", 1, 14],
    ["\u03B1\u03B5\u03B9", 1, 1],
    ["\u03B7\u03B8\u03B5\u03B9", 1, 2],
    ["\u03B7\u03C3\u03B5\u03B9", 1, 3],
    ["\u03BF\u03B9", 1, 18],
    ["\u03B1\u03BD", 1],
    ["\u03B1\u03B3\u03B1\u03BD", 1, 1],
    ["\u03B7\u03BA\u03B1\u03BD", 1, 2],
    ["\u03B7\u03B8\u03B7\u03BA\u03B1\u03BD", 1, 1],
    ["\u03B7\u03C3\u03B1\u03BD", 1, 4],
    ["\u03BF\u03C5\u03C3\u03B1\u03BD", 1, 5],
    ["\u03BF\u03BD\u03C4\u03BF\u03C5\u03C3\u03B1\u03BD", 1, 1],
    ["\u03B9\u03BF\u03BD\u03C4\u03BF\u03C5\u03C3\u03B1\u03BD", 1, 1],
    ["\u03BF\u03BD\u03C4\u03B1\u03BD", 1, 8],
    ["\u03B9\u03BF\u03BD\u03C4\u03B1\u03BD", 1, 1],
    ["\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD", 1, 10],
    ["\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD", 1, 1],
    ["\u03BF\u03C4\u03B1\u03BD", 1, 12],
    ["\u03B9\u03BF\u03C4\u03B1\u03BD", 1, 1],
    ["\u03BF\u03BC\u03B1\u03C3\u03C4\u03B1\u03BD", 1, 14],
    ["\u03B9\u03BF\u03BC\u03B1\u03C3\u03C4\u03B1\u03BD", 1, 1],
    ["\u03BF\u03C3\u03B1\u03C3\u03C4\u03B1\u03BD", 1, 16],
    ["\u03B9\u03BF\u03C3\u03B1\u03C3\u03C4\u03B1\u03BD", 1, 1],
    ["\u03BF\u03C5\u03BD", 1],
    ["\u03B7\u03B8\u03BF\u03C5\u03BD", 1, 1],
    ["\u03BF\u03BC\u03BF\u03C5\u03BD", 1, 2],
    ["\u03B9\u03BF\u03BC\u03BF\u03C5\u03BD", 1, 1],
    ["\u03B7\u03C3\u03BF\u03C5\u03BD", 1, 4],
    ["\u03BF\u03C3\u03BF\u03C5\u03BD", 1, 5],
    ["\u03B9\u03BF\u03C3\u03BF\u03C5\u03BD", 1, 1],
    ["\u03C9\u03BD", 1],
    ["\u03B7\u03B4\u03C9\u03BD", 1, 1],
    ["\u03BF", 1],
    ["\u03B1\u03C3", 1],
    ["\u03B5\u03C3", 1],
    ["\u03B7\u03B4\u03B5\u03C3", 1, 1],
    ["\u03B7\u03C3\u03B5\u03C3", 1, 2],
    ["\u03B7\u03C3", 1],
    ["\u03B5\u03B9\u03C3", 1],
    ["\u03B7\u03B8\u03B5\u03B9\u03C3", 1, 1],
    ["\u03BF\u03C3", 1],
    ["\u03C5\u03C3", 1],
    ["\u03BF\u03C5\u03C3", 1, 1],
    ["\u03C5", 1],
    ["\u03BF\u03C5", 1, 1],
    ["\u03C9", 1],
    ["\u03B1\u03C9", 1, 1],
    ["\u03B7\u03B8\u03C9", 1, 2],
    ["\u03B7\u03C3\u03C9", 1, 3]
];

const a_65: AmongTable = [
    ["\u03BF\u03C4\u03B5\u03C1", 1],
    ["\u03B5\u03C3\u03C4\u03B5\u03C1", 1],
    ["\u03C5\u03C4\u03B5\u03C1", 1],
    ["\u03C9\u03C4\u03B5\u03C1", 1],
    ["\u03BF\u03C4\u03B1\u03C4", 1],
    ["\u03B5\u03C3\u03C4\u03B1\u03C4", 1],
    ["\u03C5\u03C4\u03B1\u03C4", 1],
    ["\u03C9\u03C4\u03B1\u03C4", 1]
];

const g_v: readonly number[] = [81, 65, 16, 1];

const g_v2: readonly number[] = [81, 65, 0, 1];


export class GreekStemmer extends BaseStemmer {

    #B_test1 = false;


    /** @return {boolean} */
    #r_tolower() {
        let a: number;
        while (true) {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                this.ket = this.c;
                a = this.find_among_b(a_0);
                this.bra = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("\u03B1");
                        break;
                    }
                    case 2: {
                        this.slice_from("\u03B2");
                        break;
                    }
                    case 3: {
                        this.slice_from("\u03B3");
                        break;
                    }
                    case 4: {
                        this.slice_from("\u03B4");
                        break;
                    }
                    case 5: {
                        this.slice_from("\u03B5");
                        break;
                    }
                    case 6: {
                        this.slice_from("\u03B6");
                        break;
                    }
                    case 7: {
                        this.slice_from("\u03B7");
                        break;
                    }
                    case 8: {
                        this.slice_from("\u03B8");
                        break;
                    }
                    case 9: {
                        this.slice_from("\u03B9");
                        break;
                    }
                    case 10: {
                        this.slice_from("\u03BA");
                        break;
                    }
                    case 11: {
                        this.slice_from("\u03BB");
                        break;
                    }
                    case 12: {
                        this.slice_from("\u03BC");
                        break;
                    }
                    case 13: {
                        this.slice_from("\u03BD");
                        break;
                    }
                    case 14: {
                        this.slice_from("\u03BE");
                        break;
                    }
                    case 15: {
                        this.slice_from("\u03BF");
                        break;
                    }
                    case 16: {
                        this.slice_from("\u03C0");
                        break;
                    }
                    case 17: {
                        this.slice_from("\u03C1");
                        break;
                    }
                    case 18: {
                        this.slice_from("\u03C3");
                        break;
                    }
                    case 19: {
                        this.slice_from("\u03C4");
                        break;
                    }
                    case 20: {
                        this.slice_from("\u03C5");
                        break;
                    }
                    case 21: {
                        this.slice_from("\u03C6");
                        break;
                    }
                    case 22: {
                        this.slice_from("\u03C7");
                        break;
                    }
                    case 23: {
                        this.slice_from("\u03C8");
                        break;
                    }
                    case 24: {
                        this.slice_from("\u03C9");
                        break;
                    }
                    case 25: {
                        if (this.c <= this.limit_backward) break lab0;
                        this.c--;
                        break;
                    }
                }
                continue;
            }
            this.c = this.limit - v_1;
            break;
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_1() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_1);
        if (a === 0) return false;
        this.bra = this.c;
        this.slice_from(substitution(as_1, a - 1));
        this.#B_test1 = false;
        return true;
    }

    /** @return {boolean} */
    #r_step_s1() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_3) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from(substitution(as_2, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_step_s2() {
        this.ket = this.c;
        if (this.find_among_b(a_5) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_4) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03C9\u03BD");
        return true;
    }

    /** @return {boolean} */
    #r_step_s3() {
        let a: number;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                if (!(this.eq_s_b("\u03B9\u03C3\u03B1"))) break lab1;
                this.bra = this.c;
                if (this.c > this.limit_backward) break lab1;
                this.slice_from("\u03B9\u03C3");
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
        }
        if (this.find_among_b(a_7) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        a = this.find_among_b(a_6);
        if (a === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from(substitution(as_6, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_step_s4() {
        this.ket = this.c;
        if (this.find_among_b(a_9) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_8) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B9");
        return true;
    }

    /** @return {boolean} */
    #r_step_s5() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_11) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        a = this.find_among_b(a_10);
        if (a === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from(substitution(as_10, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_step_s6() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_14) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                a = this.find_among_b(a_12);
                if (a === 0) break lab1;
                if (this.c > this.limit_backward) break lab1;
                this.slice_from(substitution(as_12, a - 1));
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            a = this.find_among_b(a_13);
            if (a === 0) return false;
            this.bra = this.c;
            this.slice_from(substitution(as_13, a - 1));
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_s7() {
        this.ket = this.c;
        if (this.find_among_b(a_16) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_15) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B1\u03C1\u03B1\u03BA");
        return true;
    }

    /** @return {boolean} */
    #r_step_s8() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_18) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                a = this.find_among_b(a_17);
                if (a === 0) break lab1;
                if (this.c > this.limit_backward) break lab1;
                this.slice_from(substitution(as_17, a - 1));
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            this.bra = this.c;
            if (!(this.eq_s_b("\u03BA\u03BF\u03C1"))) return false;
            this.slice_from("\u03B9\u03C4\u03C3");
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_s9() {
        this.ket = this.c;
        if (this.find_among_b(a_21) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                if (this.find_among_b(a_19) === 0) break lab1;
                if (this.c > this.limit_backward) break lab1;
                this.slice_from("\u03B9\u03B4");
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            this.bra = this.c;
            if (this.find_among_b(a_20) === 0) return false;
            this.slice_from("\u03B9\u03B4");
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_s10() {
        this.ket = this.c;
        if (this.find_among_b(a_23) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_22) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B9\u03C3\u03BA");
        return true;
    }

    /** @return {boolean} */
    #r_step_2a() {
        this.ket = this.c;
        if (this.find_among_b(a_24) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                if (this.find_among_b(a_25) === 0) break lab0;
                return false;
            }
            this.c = this.limit - v_1;
        }
        {
            const c = this.c;
            this.insert(c, c, "\u03B1\u03B4");
            this.c = c;
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_2b() {
        this.ket = this.c;
        if (this.find_among_b(a_26) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_27) === 0) return false;
        this.slice_from("\u03B5\u03B4");
        return true;
    }

    /** @return {boolean} */
    #r_step_2c() {
        this.ket = this.c;
        if (this.find_among_b(a_28) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_29) === 0) return false;
        this.slice_from("\u03BF\u03C5\u03B4");
        return true;
    }

    /** @return {boolean} */
    #r_step_2d() {
        this.ket = this.c;
        if (this.find_among_b(a_30) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_31) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B5");
        return true;
    }

    /** @return {boolean} */
    #r_step_3() {
        this.ket = this.c;
        if (this.find_among_b(a_32) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (!(this.in_grouping_b(g_v, 945, 969))) return false;
        this.slice_from("\u03B9");
        return true;
    }

    /** @return {boolean} */
    #r_step_4() {
        this.ket = this.c;
        if (this.find_among_b(a_33) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                if (!(this.in_grouping_b(g_v, 945, 969))) break lab1;
                this.slice_from("\u03B9\u03BA");
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
        }
        this.bra = this.c;
        if (this.find_among_b(a_34) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B9\u03BA");
        return true;
    }

    /** @return {boolean} */
    #r_step_5a() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.eq_s_b("\u03B1\u03B3\u03B1\u03BC\u03B5"))) break lab0;
            this.bra = this.c;
            if (this.c > this.limit_backward) break lab0;
            this.slice_from("\u03B1\u03B3\u03B1\u03BC");
        }
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab1: {
            this.ket = this.c;
            if (this.find_among_b(a_35) === 0) break lab1;
            this.bra = this.c;
            this.slice_del();
            this.#B_test1 = false;
        }
        this.c = this.limit - v_2;
        this.ket = this.c;
        if (!(this.eq_s_b("\u03B1\u03BC\u03B5"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_36) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B1\u03BC");
        return true;
    }

    /** @return {boolean} */
    #r_step_5b() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (this.find_among_b(a_38) === 0) break lab0;
            this.bra = this.c;
            this.slice_del();
            this.#B_test1 = false;
            this.ket = this.c;
            this.bra = this.c;
            if (this.find_among_b(a_37) === 0) break lab0;
            if (this.c > this.limit_backward) break lab0;
            this.slice_from("\u03B1\u03B3\u03B1\u03BD");
        }
        this.c = this.limit - v_1;
        this.ket = this.c;
        if (!(this.eq_s_b("\u03B1\u03BD\u03B5"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab1: {
            const v_2 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab2: {
                this.ket = this.c;
                this.bra = this.c;
                if (!(this.in_grouping_b(g_v2, 945, 969))) break lab2;
                this.slice_from("\u03B1\u03BD");
                break lab1;
            }
            this.c = this.limit - v_2;
            this.ket = this.c;
        }
        this.bra = this.c;
        if (this.find_among_b(a_39) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B1\u03BD");
        return true;
    }

    /** @return {boolean} */
    #r_step_5c() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.eq_s_b("\u03B7\u03C3\u03B5\u03C4\u03B5"))) break lab0;
            this.bra = this.c;
            this.slice_del();
            this.#B_test1 = false;
        }
        this.c = this.limit - v_1;
        this.ket = this.c;
        if (!(this.eq_s_b("\u03B5\u03C4\u03B5"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab1: {
            const v_2 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab2: {
                this.ket = this.c;
                this.bra = this.c;
                if (!(this.in_grouping_b(g_v2, 945, 969))) break lab2;
                this.slice_from("\u03B5\u03C4");
                break lab1;
            }
            this.c = this.limit - v_2;
            // deno-lint-ignore no-unused-labels
            lab3: {
                this.ket = this.c;
                this.bra = this.c;
                if (this.find_among_b(a_40) === 0) break lab3;
                this.slice_from("\u03B5\u03C4");
                break lab1;
            }
            this.c = this.limit - v_2;
            this.ket = this.c;
        }
        this.bra = this.c;
        if (this.find_among_b(a_41) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B5\u03C4");
        return true;
    }

    /** @return {boolean} */
    #r_step_5d() {
        this.ket = this.c;
        if (this.find_among_b(a_42) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                if (!(this.eq_s_b("\u03B1\u03C1\u03C7"))) break lab1;
                if (this.c > this.limit_backward) break lab1;
                this.slice_from("\u03BF\u03BD\u03C4");
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            this.bra = this.c;
            if (!(this.eq_s_b("\u03BA\u03C1\u03B5"))) return false;
            this.slice_from("\u03C9\u03BD\u03C4");
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_5e() {
        this.ket = this.c;
        if (this.find_among_b(a_43) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (!(this.eq_s_b("\u03BF\u03BD"))) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03BF\u03BC\u03B1\u03C3\u03C4");
        return true;
    }

    /** @return {boolean} */
    #r_step_5f() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.eq_s_b("\u03B9\u03B5\u03C3\u03C4\u03B5"))) break lab0;
            this.bra = this.c;
            this.slice_del();
            this.#B_test1 = false;
            this.ket = this.c;
            this.bra = this.c;
            if (this.find_among_b(a_44) === 0) break lab0;
            if (this.c > this.limit_backward) break lab0;
            this.slice_from("\u03B9\u03B5\u03C3\u03C4");
        }
        this.c = this.limit - v_1;
        this.ket = this.c;
        if (!(this.eq_s_b("\u03B5\u03C3\u03C4\u03B5"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_45) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B9\u03B5\u03C3\u03C4");
        return true;
    }

    /** @return {boolean} */
    #r_step_5g() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (this.find_among_b(a_46) === 0) break lab0;
            this.bra = this.c;
            this.slice_del();
            this.#B_test1 = false;
        }
        this.c = this.limit - v_1;
        this.ket = this.c;
        if (this.find_among_b(a_49) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab1: {
            const v_2 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab2: {
                this.ket = this.c;
                this.bra = this.c;
                if (this.find_among_b(a_47) === 0) break lab2;
                this.slice_from("\u03B7\u03BA");
                break lab1;
            }
            this.c = this.limit - v_2;
            this.ket = this.c;
            this.bra = this.c;
            if (this.find_among_b(a_48) === 0) return false;
            if (this.c > this.limit_backward) return false;
            this.slice_from("\u03B7\u03BA");
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_5h() {
        this.ket = this.c;
        if (this.find_among_b(a_52) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                if (this.find_among_b(a_50) === 0) break lab1;
                this.slice_from("\u03BF\u03C5\u03C3");
                break lab0;
            }
            this.c = this.limit - v_1;
            this.ket = this.c;
            this.bra = this.c;
            if (this.find_among_b(a_51) === 0) return false;
            if (this.c > this.limit_backward) return false;
            this.slice_from("\u03BF\u03C5\u03C3");
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_5i() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_55) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                this.ket = this.c;
                this.bra = this.c;
                if (!(this.eq_s_b("\u03BA\u03BF\u03BB\u03BB"))) break lab1;
                this.slice_from("\u03B1\u03B3");
                break lab0;
            }
            this.c = this.limit - v_1;
            // deno-lint-ignore no-unused-labels
            lab2: {
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    this.ket = this.c;
                    this.bra = this.c;
                    a = this.find_among_b(a_53);
                    if (a === 0) break lab3;
                    switch (a) {
                        case 1: {
                            this.slice_from("\u03B1\u03B3");
                            break;
                        }
                    }
                    break lab2;
                }
                this.c = this.limit - v_2;
                this.ket = this.c;
                this.bra = this.c;
                if (this.find_among_b(a_54) === 0) return false;
                if (this.c > this.limit_backward) return false;
                this.slice_from("\u03B1\u03B3");
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_step_5j() {
        this.ket = this.c;
        if (this.find_among_b(a_56) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_57) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B7\u03C3");
        return true;
    }

    /** @return {boolean} */
    #r_step_5k() {
        this.ket = this.c;
        if (!(this.eq_s_b("\u03B7\u03C3\u03C4\u03B5"))) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_58) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03B7\u03C3\u03C4");
        return true;
    }

    /** @return {boolean} */
    #r_step_5l() {
        this.ket = this.c;
        if (this.find_among_b(a_59) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_60) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03BF\u03C5\u03BD");
        return true;
    }

    /** @return {boolean} */
    #r_step_5m() {
        this.ket = this.c;
        if (this.find_among_b(a_61) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        this.#B_test1 = false;
        this.ket = this.c;
        this.bra = this.c;
        if (this.find_among_b(a_62) === 0) return false;
        if (this.c > this.limit_backward) return false;
        this.slice_from("\u03BF\u03C5\u03BC");
        return true;
    }

    /** @return {boolean} */
    #r_step_6() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (this.find_among_b(a_63) === 0) break lab0;
            this.bra = this.c;
            this.slice_from("\u03BC\u03B1");
        }
        this.c = this.limit - v_1;
        if (!this.#B_test1) return false;
        this.ket = this.c;
        if (this.find_among_b(a_64) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_step_7() {
        this.ket = this.c;
        if (this.find_among_b(a_65) === 0) return false;
        this.bra = this.c;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #stem() {
        this.limit_backward = this.c; this.c = this.limit;
        const v_1 = this.limit - this.c;
        this.#r_tolower();
        this.c = this.limit - v_1;
        if (this.current.length < 3) return false;
        this.#B_test1 = true;
        const v_2 = this.limit - this.c;
        this.#r_step_1();
        this.c = this.limit - v_2;
        const v_3 = this.limit - this.c;
        this.#r_step_s1();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_step_s2();
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_step_s3();
        this.c = this.limit - v_5;
        const v_6 = this.limit - this.c;
        this.#r_step_s4();
        this.c = this.limit - v_6;
        const v_7 = this.limit - this.c;
        this.#r_step_s5();
        this.c = this.limit - v_7;
        const v_8 = this.limit - this.c;
        this.#r_step_s6();
        this.c = this.limit - v_8;
        const v_9 = this.limit - this.c;
        this.#r_step_s7();
        this.c = this.limit - v_9;
        const v_10 = this.limit - this.c;
        this.#r_step_s8();
        this.c = this.limit - v_10;
        const v_11 = this.limit - this.c;
        this.#r_step_s9();
        this.c = this.limit - v_11;
        const v_12 = this.limit - this.c;
        this.#r_step_s10();
        this.c = this.limit - v_12;
        const v_13 = this.limit - this.c;
        this.#r_step_2a();
        this.c = this.limit - v_13;
        const v_14 = this.limit - this.c;
        this.#r_step_2b();
        this.c = this.limit - v_14;
        const v_15 = this.limit - this.c;
        this.#r_step_2c();
        this.c = this.limit - v_15;
        const v_16 = this.limit - this.c;
        this.#r_step_2d();
        this.c = this.limit - v_16;
        const v_17 = this.limit - this.c;
        this.#r_step_3();
        this.c = this.limit - v_17;
        const v_18 = this.limit - this.c;
        this.#r_step_4();
        this.c = this.limit - v_18;
        const v_19 = this.limit - this.c;
        this.#r_step_5a();
        this.c = this.limit - v_19;
        const v_20 = this.limit - this.c;
        this.#r_step_5b();
        this.c = this.limit - v_20;
        const v_21 = this.limit - this.c;
        this.#r_step_5c();
        this.c = this.limit - v_21;
        const v_22 = this.limit - this.c;
        this.#r_step_5d();
        this.c = this.limit - v_22;
        const v_23 = this.limit - this.c;
        this.#r_step_5e();
        this.c = this.limit - v_23;
        const v_24 = this.limit - this.c;
        this.#r_step_5f();
        this.c = this.limit - v_24;
        const v_25 = this.limit - this.c;
        this.#r_step_5g();
        this.c = this.limit - v_25;
        const v_26 = this.limit - this.c;
        this.#r_step_5h();
        this.c = this.limit - v_26;
        const v_27 = this.limit - this.c;
        this.#r_step_5j();
        this.c = this.limit - v_27;
        const v_28 = this.limit - this.c;
        this.#r_step_5i();
        this.c = this.limit - v_28;
        const v_29 = this.limit - this.c;
        this.#r_step_5k();
        this.c = this.limit - v_29;
        const v_30 = this.limit - this.c;
        this.#r_step_5l();
        this.c = this.limit - v_30;
        const v_31 = this.limit - this.c;
        this.#r_step_5m();
        this.c = this.limit - v_31;
        const v_32 = this.limit - this.c;
        this.#r_step_6();
        this.c = this.limit - v_32;
        const v_33 = this.limit - this.c;
        this.#r_step_7();
        this.c = this.limit - v_33;
        this.c = this.limit_backward;
        return true;
    }

    /**@return{string}*/
    stem(input: string): string {
        this.setCurrent(input);
        this.#stem();
        return this.getCurrent();
    }

    stemWord = this.stem;
}
