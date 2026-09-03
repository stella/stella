/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/portuguese.sbl -js -o portuguese
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

// Generated from portuguese.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["", 3],
    ["\u00E3", 1, 1],
    ["\u00F5", 2, 2]
];

const a_1: AmongTable = [
    ["", 3],
    ["a~", 1, 1],
    ["o~", 2, 2]
];

const a_2: AmongTable = [
    ["ic", -1],
    ["ad", -1],
    ["os", -1],
    ["iv", 1]
];

const a_3: AmongTable = [
    ["ante", 1],
    ["avel", 1],
    ["\u00EDvel", 1]
];

const a_4: AmongTable = [
    ["ic", 1],
    ["abil", 1],
    ["iv", 1]
];

const a_5: AmongTable = [
    ["ica", 1],
    ["\u00E2ncia", 1],
    ["\u00EAncia", 4],
    ["logia", 2],
    ["ira", 9],
    ["adora", 1],
    ["osa", 1],
    ["ista", 1],
    ["iva", 8],
    ["eza", 1],
    ["idade", 7],
    ["ante", 1],
    ["mente", 6],
    ["amente", 5, 1],
    ["\u00E1vel", 1],
    ["\u00EDvel", 1],
    ["ico", 1],
    ["ismo", 1],
    ["oso", 1],
    ["amento", 1],
    ["imento", 1],
    ["ivo", 8],
    ["a\u00E7a~o", 1],
    ["u\u00E7a~o", 3],
    ["ador", 1],
    ["icas", 1],
    ["\u00EAncias", 4],
    ["logias", 2],
    ["iras", 9],
    ["adoras", 1],
    ["osas", 1],
    ["istas", 1],
    ["ivas", 8],
    ["ezas", 1],
    ["idades", 7],
    ["adores", 1],
    ["antes", 1],
    ["a\u00E7o~es", 1],
    ["u\u00E7o~es", 3],
    ["icos", 1],
    ["ismos", 1],
    ["osos", 1],
    ["amentos", 1],
    ["imentos", 1],
    ["ivos", 8]
];

const a_6: AmongTable = [
    ["ada", 1],
    ["ida", 1],
    ["ia", 1],
    ["aria", 1, 1],
    ["eria", 1, 2],
    ["iria", 1, 3],
    ["ara", 1],
    ["era", 1],
    ["ira", 1],
    ["ava", 1],
    ["asse", 1],
    ["esse", 1],
    ["isse", 1],
    ["aste", 1],
    ["este", 1],
    ["iste", 1],
    ["ei", 1],
    ["arei", 1, 1],
    ["erei", 1, 2],
    ["irei", 1, 3],
    ["am", 1],
    ["iam", 1, 1],
    ["ariam", 1, 1],
    ["eriam", 1, 2],
    ["iriam", 1, 3],
    ["aram", 1, 5],
    ["eram", 1, 6],
    ["iram", 1, 7],
    ["avam", 1, 8],
    ["em", 1],
    ["arem", 1, 1],
    ["erem", 1, 2],
    ["irem", 1, 3],
    ["assem", 1, 4],
    ["essem", 1, 5],
    ["issem", 1, 6],
    ["ado", 1],
    ["ido", 1],
    ["ando", 1],
    ["endo", 1],
    ["indo", 1],
    ["ara~o", 1],
    ["era~o", 1],
    ["ira~o", 1],
    ["ar", 1],
    ["er", 1],
    ["ir", 1],
    ["as", 1],
    ["adas", 1, 1],
    ["idas", 1, 2],
    ["ias", 1, 3],
    ["arias", 1, 1],
    ["erias", 1, 2],
    ["irias", 1, 3],
    ["aras", 1, 7],
    ["eras", 1, 8],
    ["iras", 1, 9],
    ["avas", 1, 10],
    ["es", 1],
    ["ardes", 1, 1],
    ["erdes", 1, 2],
    ["irdes", 1, 3],
    ["ares", 1, 4],
    ["eres", 1, 5],
    ["ires", 1, 6],
    ["asses", 1, 7],
    ["esses", 1, 8],
    ["isses", 1, 9],
    ["astes", 1, 10],
    ["estes", 1, 11],
    ["istes", 1, 12],
    ["is", 1],
    ["ais", 1, 1],
    ["eis", 1, 2],
    ["areis", 1, 1],
    ["ereis", 1, 2],
    ["ireis", 1, 3],
    ["\u00E1reis", 1, 4],
    ["\u00E9reis", 1, 5],
    ["\u00EDreis", 1, 6],
    ["\u00E1sseis", 1, 7],
    ["\u00E9sseis", 1, 8],
    ["\u00EDsseis", 1, 9],
    ["\u00E1veis", 1, 10],
    ["\u00EDeis", 1, 11],
    ["ar\u00EDeis", 1, 1],
    ["er\u00EDeis", 1, 2],
    ["ir\u00EDeis", 1, 3],
    ["ados", 1],
    ["idos", 1],
    ["amos", 1],
    ["\u00E1ramos", 1, 1],
    ["\u00E9ramos", 1, 2],
    ["\u00EDramos", 1, 3],
    ["\u00E1vamos", 1, 4],
    ["\u00EDamos", 1, 5],
    ["ar\u00EDamos", 1, 1],
    ["er\u00EDamos", 1, 2],
    ["ir\u00EDamos", 1, 3],
    ["emos", 1],
    ["aremos", 1, 1],
    ["eremos", 1, 2],
    ["iremos", 1, 3],
    ["\u00E1ssemos", 1, 4],
    ["\u00EAssemos", 1, 5],
    ["\u00EDssemos", 1, 6],
    ["imos", 1],
    ["armos", 1],
    ["ermos", 1],
    ["irmos", 1],
    ["\u00E1mos", 1],
    ["ar\u00E1s", 1],
    ["er\u00E1s", 1],
    ["ir\u00E1s", 1],
    ["eu", 1],
    ["iu", 1],
    ["ou", 1],
    ["ar\u00E1", 1],
    ["er\u00E1", 1],
    ["ir\u00E1", 1]
];

const a_7: AmongTable = [
    ["a", 1],
    ["i", 1],
    ["o", 1],
    ["os", 1],
    ["\u00E1", 1],
    ["\u00ED", 1],
    ["\u00F3", 1]
];

const a_8: AmongTable = [
    ["e", 1],
    ["\u00E7", 2],
    ["\u00E9", 1],
    ["\u00EA", 1]
];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 19, 12, 2];


export class PortugueseStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_prelude() {
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
                        this.slice_from("a~");
                        break;
                    }
                    case 2: {
                        this.slice_from("o~");
                        break;
                    }
                    case 3: {
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
                    if (!(this.in_grouping(g_v, 97, 250))) break lab2;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_3 = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.out_grouping(g_v, 97, 250))) break lab4;
                            if (!this.go_out_grouping(g_v, 97, 250)) break lab4;
                            this.c++;
                            break lab3;
                        }
                        this.c = v_3;
                        if (!(this.in_grouping(g_v, 97, 250))) break lab2;
                        if (!this.go_in_grouping(g_v, 97, 250)) break lab2;
                        this.c++;
                    }
                    break lab1;
                }
                this.c = v_2;
                if (!(this.out_grouping(g_v, 97, 250))) break lab0;
                // deno-lint-ignore no-unused-labels
                lab5: {
                    const v_4 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab6: {
                        if (!(this.out_grouping(g_v, 97, 250))) break lab6;
                        if (!this.go_out_grouping(g_v, 97, 250)) break lab6;
                        this.c++;
                        break lab5;
                    }
                    this.c = v_4;
                    if (!(this.in_grouping(g_v, 97, 250))) break lab0;
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
            if (!this.go_out_grouping(g_v, 97, 250)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 250)) break lab7;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 250)) break lab7;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 250)) break lab7;
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
                a = this.find_among(a_1);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("\u00E3");
                        break;
                    }
                    case 2: {
                        this.slice_from("\u00F5");
                        break;
                    }
                    case 3: {
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
    #r_standard_suffix() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_5);
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
                this.slice_from("log");
                break;
            }
            case 3: {
                if (!this.#r_R2()) return false;
                this.slice_from("u");
                break;
            }
            case 4: {
                if (!this.#r_R2()) return false;
                this.slice_from("ente");
                break;
            }
            case 5: {
                if (this.#I_p1 > this.c) return false;
                this.slice_del();
                const v_1 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    this.ket = this.c;
                    a = this.find_among_b(a_2);
                    if (a === 0) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_1;
                        break lab0;
                    }
                    this.slice_del();
                    switch (a) {
                        case 1: {
                            this.ket = this.c;
                            if (!(this.eq_s_b("at"))) {
                                this.c = this.limit - v_1;
                                break lab0;
                            }
                            this.bra = this.c;
                            if (!this.#r_R2()) {
                                this.c = this.limit - v_1;
                                break lab0;
                            }
                            this.slice_del();
                            break;
                        }
                    }
                }
                break;
            }
            case 6: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab1: {
                    this.ket = this.c;
                    if (this.find_among_b(a_3) === 0) {
                        this.c = this.limit - v_2;
                        break lab1;
                    }
                    this.bra = this.c;
                    if (!this.#r_R2()) {
                        this.c = this.limit - v_2;
                        break lab1;
                    }
                    this.slice_del();
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
                    if (!(this.eq_s_b("at"))) {
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
                if (!this.#r_RV()) return false;
                if (!(this.eq_s_b("e"))) return false;
                this.slice_from("ir");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #r_verb_suffix() {
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        if (this.find_among_b(a_6) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.slice_del();
        this.limit_backward = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_residual_suffix() {
        this.ket = this.c;
        if (this.find_among_b(a_7) === 0) return false;
        this.bra = this.c;
        if (!this.#r_RV()) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_residual_form() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_8);
        if (a === 0) return false;
        this.bra = this.c;
        switch (a) {
            case 1: {
                if (!this.#r_RV()) return false;
                this.slice_del();
                this.ket = this.c;
                // deno-lint-ignore no-unused-labels
                lab0: {
                    const v_1 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab1: {
                        if (!(this.eq_s_b("u"))) break lab1;
                        this.bra = this.c;
                        const v_2 = this.limit - this.c;
                        if (!(this.eq_s_b("g"))) break lab1;
                        this.c = this.limit - v_2;
                        break lab0;
                    }
                    this.c = this.limit - v_1;
                    if (!(this.eq_s_b("i"))) return false;
                    this.bra = this.c;
                    const v_3 = this.limit - this.c;
                    if (!(this.eq_s_b("c"))) return false;
                    this.c = this.limit - v_3;
                }
                if (!this.#r_RV()) return false;
                this.slice_del();
                break;
            }
            case 2: {
                this.slice_from("c");
                break;
            }
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_prelude();
        this.c = v_1;
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_3 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    const v_4 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_5 = this.limit - this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!this.#r_standard_suffix()) break lab4;
                            break lab3;
                        }
                        this.c = this.limit - v_5;
                        if (!this.#r_verb_suffix()) break lab2;
                    }
                    this.c = this.limit - v_4;
                    const v_6 = this.limit - this.c;
                    // deno-lint-ignore no-unused-labels
                    lab5: {
                        this.ket = this.c;
                        if (!(this.eq_s_b("i"))) break lab5;
                        this.bra = this.c;
                        const v_7 = this.limit - this.c;
                        if (!(this.eq_s_b("c"))) break lab5;
                        this.c = this.limit - v_7;
                        if (!this.#r_RV()) break lab5;
                        this.slice_del();
                    }
                    this.c = this.limit - v_6;
                    break lab1;
                }
                this.c = this.limit - v_3;
                if (!this.#r_residual_suffix()) break lab0;
            }
        }
        this.c = this.limit - v_2;
        const v_8 = this.limit - this.c;
        this.#r_residual_form();
        this.c = this.limit - v_8;
        this.c = this.limit_backward;
        const v_9 = this.c;
        this.#r_postlude();
        this.c = v_9;
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
