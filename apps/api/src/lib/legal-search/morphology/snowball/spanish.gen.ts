/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/spanish.sbl -js -o spanish
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
} from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

// Generated from spanish.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["", 6],
    ["\u00E1", 1, 1],
    ["\u00E9", 2, 2],
    ["\u00ED", 3, 3],
    ["\u00F3", 4, 4],
    ["\u00FA", 5, 5]
];

const a_1: AmongTable = [
    ["la", -1],
    ["sela", -1, 1],
    ["le", -1],
    ["me", -1],
    ["se", -1],
    ["lo", -1],
    ["selo", -1, 1],
    ["las", -1],
    ["selas", -1, 1],
    ["les", -1],
    ["los", -1],
    ["selos", -1, 1],
    ["nos", -1]
];

const a_2: AmongTable = [
    ["ando", 6],
    ["iendo", 6],
    ["yendo", 7],
    ["\u00E1ndo", 2],
    ["i\u00E9ndo", 1],
    ["ar", 6],
    ["er", 6],
    ["ir", 6],
    ["\u00E1r", 3],
    ["\u00E9r", 4],
    ["\u00EDr", 5]
];

const a_3: AmongTable = [
    ["ic", -1],
    ["ad", -1],
    ["os", -1],
    ["iv", 1]
];

const a_4: AmongTable = [
    ["able", 1],
    ["ible", 1],
    ["ante", 1]
];

const a_5: AmongTable = [
    ["ic", 1],
    ["abil", 1],
    ["iv", 1]
];

const a_6: AmongTable = [
    ["ica", 1],
    ["ancia", 2],
    ["encia", 5],
    ["adora", 2],
    ["osa", 1],
    ["ista", 1],
    ["iva", 9],
    ["anza", 1],
    ["log\u00EDa", 3],
    ["idad", 8],
    ["able", 1],
    ["ible", 1],
    ["ante", 2],
    ["mente", 7],
    ["amente", 6, 1],
    ["acion", 2],
    ["ucion", 4],
    ["aci\u00F3n", 2],
    ["uci\u00F3n", 4],
    ["ico", 1],
    ["ismo", 1],
    ["oso", 1],
    ["amiento", 1],
    ["imiento", 1],
    ["ivo", 9],
    ["ador", 2],
    ["icas", 1],
    ["ancias", 2],
    ["encias", 5],
    ["adoras", 2],
    ["osas", 1],
    ["istas", 1],
    ["ivas", 9],
    ["anzas", 1],
    ["log\u00EDas", 3],
    ["idades", 8],
    ["ables", 1],
    ["ibles", 1],
    ["aciones", 2],
    ["uciones", 4],
    ["adores", 2],
    ["antes", 2],
    ["icos", 1],
    ["ismos", 1],
    ["osos", 1],
    ["amientos", 1],
    ["imientos", 1],
    ["ivos", 9]
];

const a_7: AmongTable = [
    ["ya", 1],
    ["ye", 1],
    ["yan", 1],
    ["yen", 1],
    ["yeron", 1],
    ["yendo", 1],
    ["yo", 1],
    ["yas", 1],
    ["yes", 1],
    ["yais", 1],
    ["yamos", 1],
    ["y\u00F3", 1]
];

const a_8: AmongTable = [
    ["aba", 2],
    ["ada", 2],
    ["ida", 2],
    ["ara", 2],
    ["iera", 2],
    ["\u00EDa", 2],
    ["ar\u00EDa", 2, 1],
    ["er\u00EDa", 2, 2],
    ["ir\u00EDa", 2, 3],
    ["ad", 2],
    ["ed", 2],
    ["id", 2],
    ["ase", 2],
    ["iese", 2],
    ["aste", 2],
    ["iste", 2],
    ["an", 2],
    ["aban", 2, 1],
    ["aran", 2, 2],
    ["ieran", 2, 3],
    ["\u00EDan", 2, 4],
    ["ar\u00EDan", 2, 1],
    ["er\u00EDan", 2, 2],
    ["ir\u00EDan", 2, 3],
    ["en", 1],
    ["asen", 2, 1],
    ["iesen", 2, 2],
    ["aron", 2],
    ["ieron", 2],
    ["ar\u00E1n", 2],
    ["er\u00E1n", 2],
    ["ir\u00E1n", 2],
    ["ado", 2],
    ["ido", 2],
    ["ando", 2],
    ["iendo", 2],
    ["ar", 2],
    ["er", 2],
    ["ir", 2],
    ["as", 2],
    ["abas", 2, 1],
    ["adas", 2, 2],
    ["idas", 2, 3],
    ["aras", 2, 4],
    ["ieras", 2, 5],
    ["\u00EDas", 2, 6],
    ["ar\u00EDas", 2, 1],
    ["er\u00EDas", 2, 2],
    ["ir\u00EDas", 2, 3],
    ["es", 1],
    ["ases", 2, 1],
    ["ieses", 2, 2],
    ["abais", 2],
    ["arais", 2],
    ["ierais", 2],
    ["\u00EDais", 2],
    ["ar\u00EDais", 2, 1],
    ["er\u00EDais", 2, 2],
    ["ir\u00EDais", 2, 3],
    ["aseis", 2],
    ["ieseis", 2],
    ["asteis", 2],
    ["isteis", 2],
    ["\u00E1is", 2],
    ["\u00E9is", 1],
    ["ar\u00E9is", 2, 1],
    ["er\u00E9is", 2, 2],
    ["ir\u00E9is", 2, 3],
    ["ados", 2],
    ["idos", 2],
    ["amos", 2],
    ["\u00E1bamos", 2, 1],
    ["\u00E1ramos", 2, 2],
    ["i\u00E9ramos", 2, 3],
    ["\u00EDamos", 2, 4],
    ["ar\u00EDamos", 2, 1],
    ["er\u00EDamos", 2, 2],
    ["ir\u00EDamos", 2, 3],
    ["emos", 1],
    ["aremos", 2, 1],
    ["eremos", 2, 2],
    ["iremos", 2, 3],
    ["\u00E1semos", 2, 4],
    ["i\u00E9semos", 2, 5],
    ["imos", 2],
    ["ar\u00E1s", 2],
    ["er\u00E1s", 2],
    ["ir\u00E1s", 2],
    ["\u00EDs", 2],
    ["ar\u00E1", 2],
    ["er\u00E1", 2],
    ["ir\u00E1", 2],
    ["ar\u00E9", 2],
    ["er\u00E9", 2],
    ["ir\u00E9", 2],
    ["i\u00F3", 2]
];

const a_9: AmongTable = [
    ["a", 1],
    ["e", 2],
    ["o", 1],
    ["os", 1],
    ["\u00E1", 1],
    ["\u00E9", 2],
    ["\u00ED", 1],
    ["\u00F3", 1]
];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 10];


export class SpanishStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_mark_regions() {
        this.#I_pV = this.limit;
        this.#I_p1 = this.limit;
        this.#I_p2 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_2 = this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!(this.in_grouping(g_v, 97, 252))) break lab2;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_3 = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.out_grouping(g_v, 97, 252))) break lab4;
                            if (!this.go_out_grouping(g_v, 97, 252)) break lab4;
                            this.c++;
                            break lab3;
                        }
                        this.c = v_3;
                        if (!(this.in_grouping(g_v, 97, 252))) break lab2;
                        if (!this.go_in_grouping(g_v, 97, 252)) break lab2;
                        this.c++;
                    }
                    break lab1;
                }
                this.c = v_2;
                if (!(this.out_grouping(g_v, 97, 252))) break lab0;
                // deno-lint-ignore no-unused-labels
                lab5: {
                    const v_4 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.out_grouping(g_v, 97, 252))) break lab6;
                        if (!this.go_out_grouping(g_v, 97, 252)) break lab6;
                        this.c++;
                        break lab5;
                    }
                    this.c = v_4;
                    if (!(this.in_grouping(g_v, 97, 252))) break lab0;
                    if (this.c >= this.limit) break lab0;
                    this.c++;
                }
            }
            this.#I_pV = this.c;
        }
        this.c = v_1;
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab7: {
            if (!this.go_out_grouping(g_v, 97, 252)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 252)) break lab7;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 252)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 252)) break lab7;
            this.c++;
            this.#I_p2 = this.c;
        }
        this.c = v_5;
        return true;
    }

    /** @return {boolean} */
    #r_postlude() {
        let a: number;
        while (true) {
            const v_1 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                this.bra = this.c;
                a = this.find_among(a_0);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("a");
                        break;
                    }
                    case 2: {
                        this.slice_from("e");
                        break;
                    }
                    case 3: {
                        this.slice_from("i");
                        break;
                    }
                    case 4: {
                        this.slice_from("o");
                        break;
                    }
                    case 5: {
                        this.slice_from("u");
                        break;
                    }
                    case 6: {
                        if (this.c >= this.limit) break lab0;
                        this.c++;
                        break;
                    }
                }
                continue;
            }
            this.c = v_1;
            break;
        }
        return true;
    }

    /** @return {boolean} */
    #r_RV() {
        return this.#I_pV <= this.c;
    }

    /** @return {boolean} */
    #r_R2() {
        return this.#I_p2 <= this.c;
    }

    /** @return {boolean} */
    #r_attached_pronoun() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_1) === 0) return false;
        this.bra = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        if (!this.#r_RV()) return false;
        switch (a) {
            case 1: {
                this.bra = this.c;
                this.slice_from("iendo");
                break;
            }
            case 2: {
                this.bra = this.c;
                this.slice_from("ando");
                break;
            }
            case 3: {
                this.bra = this.c;
                this.slice_from("ar");
                break;
            }
            case 4: {
                this.bra = this.c;
                this.slice_from("er");
                break;
            }
            case 5: {
                this.bra = this.c;
                this.slice_from("ir");
                break;
            }
            case 6: {
                this.slice_del();
                break;
            }
            case 7: {
                if (!(this.eq_s_b("u"))) return false;
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_standard_suffix() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_6);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_1 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    this.ket = this.c;
                    if (!(this.eq_s_b("ic"))) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.slice_del();
                }
                break;
            }
            case 3: {
                if (!this.#r_R2()) return false;
                this.slice_from("log");
                break;
            }
            case 4: {
                if (!this.#r_R2()) return false;
                this.slice_from("u");
                break;
            }
            case 5: {
                if (!this.#r_R2()) return false;
                this.slice_from("ente");
                break;
            }
            case 6: {
                if (this.#I_p1 > this.c) return false;
                this.slice_del();
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab1: {
                    this.ket = this.c;
                    a = this.find_among_b(a_3);
                    if (a === 0) {
                        this.c = this.limit - v_2;
                        break lab1;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_2;
                        break lab1;
                    }
                    this.slice_del();
                    switch (a) {
                        case 1: {
                            this.ket = this.c;
                            if (!(this.eq_s_b("at"))) {
                                this.c = this.limit - v_2;
                                break lab1;
                            }
                            this.bra = this.c;
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_2;
                                break lab1;
                            }
                            this.slice_del();
                            break;
                        }
                    }
                }
                break;
            }
            case 7: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_3 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    this.ket = this.c;
                    if (this.find_among_b(a_4) === 0) {
                        this.c = this.limit - v_3;
                        break lab2;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_3;
                        break lab2;
                    }
                    this.slice_del();
                }
                break;
            }
            case 8: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_4 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    this.ket = this.c;
                    if (this.find_among_b(a_5) === 0) {
                        this.c = this.limit - v_4;
                        break lab3;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_4;
                        break lab3;
                    }
                    this.slice_del();
                }
                break;
            }
            case 9: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_5 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab4: {
                    this.ket = this.c;
                    if (!(this.eq_s_b("at"))) {
                        this.c = this.limit - v_5;
                        break lab4;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_5;
                        break lab4;
                    }
                    this.slice_del();
                }
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_y_verb_suffix() {
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        if (this.find_among_b(a_7) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        if (!(this.eq_s_b("u"))) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_verb_suffix() {
        let a: number;
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        switch (a) {
            case 1: {
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    if (!(this.eq_s_b("u"))) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    const v_3 = this.limit - this.c;
                    if (!(this.eq_s_b("g"))) {
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    this.c = this.limit - v_3;
                }
                this.bra = this.c;
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_del();
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_residual_suffix() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_9);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_RV()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                if (!this.#r_RV()) return false;
                this.slice_del();
                const v_1 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    this.ket = this.c;
                    if (!(this.eq_s_b("u"))) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.bra = this.c;
                    const v_2 = this.limit - this.c;
                    if (!(this.eq_s_b("g"))) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.c = this.limit - v_2;
                    if (!this.#r_RV()) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.slice_del();
                }
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_1 = this.limit - this.c;
        this.#r_attached_pronoun();
        this.c = this.limit - v_1;
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_3 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!this.#r_standard_suffix()) break lab2;
                    break lab1;
                }
                this.c = this.limit - v_3;
                // deno-lint-ignore no-unused-labels
                lab3: {
                    if (!this.#r_y_verb_suffix()) break lab3;
                    break lab1;
                }
                this.c = this.limit - v_3;
                if (!this.#r_verb_suffix()) break lab0;
            }
        }
        this.c = this.limit - v_2;
        const v_4 = this.limit - this.c;
        this.#r_residual_suffix();
        this.c = this.limit - v_4;
        this.c = this.limit_backward;
        const v_5 = this.c;
        this.#r_postlude();
        this.c = v_5;
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
