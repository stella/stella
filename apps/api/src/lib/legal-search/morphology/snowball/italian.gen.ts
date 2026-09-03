/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/italian.sbl -js -o italian
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

// Generated from italian.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["all'", -1],
    ["d'", -1],
    ["dall'", -1],
    ["dell'", -1],
    ["gl'", -1],
    ["l'", -1],
    ["m'", -1],
    ["nell'", -1],
    ["quell'", -1],
    ["quest'", -1],
    ["s'", -1],
    ["sull'", -1],
    ["t'", -1],
    ["tutt'", -1],
    ["un'", -1],
    ["v'", -1]
];

const a_1: AmongTable = [
    ["", 7],
    ["qu", 6, 1],
    ["\u00E1", 1, 2],
    ["\u00E9", 2, 3],
    ["\u00ED", 3, 4],
    ["\u00F3", 4, 5],
    ["\u00FA", 5, 6]
];

const a_2: AmongTable = [
    ["", 3],
    ["I", 1, 1],
    ["U", 2, 2]
];

const a_3: AmongTable = [
    ["la", -1],
    ["cela", -1, 1],
    ["gliela", -1, 2],
    ["mela", -1, 3],
    ["tela", -1, 4],
    ["vela", -1, 5],
    ["le", -1],
    ["cele", -1, 1],
    ["gliele", -1, 2],
    ["mele", -1, 3],
    ["tele", -1, 4],
    ["vele", -1, 5],
    ["ne", -1],
    ["cene", -1, 1],
    ["gliene", -1, 2],
    ["mene", -1, 3],
    ["sene", -1, 4],
    ["tene", -1, 5],
    ["vene", -1, 6],
    ["ci", -1],
    ["li", -1],
    ["celi", -1, 1],
    ["glieli", -1, 2],
    ["meli", -1, 3],
    ["teli", -1, 4],
    ["veli", -1, 5],
    ["gli", -1, 6],
    ["mi", -1],
    ["si", -1],
    ["ti", -1],
    ["vi", -1],
    ["lo", -1],
    ["celo", -1, 1],
    ["glielo", -1, 2],
    ["melo", -1, 3],
    ["telo", -1, 4],
    ["velo", -1, 5]
];

const a_4: AmongTable = [
    ["ando", 1],
    ["endo", 1],
    ["ar", 2],
    ["er", 2],
    ["ir", 2]
];

const as_4: readonly string[] = ["", "e"];

const a_5: AmongTable = [
    ["ic", -1],
    ["abil", -1],
    ["os", -1],
    ["iv", 1]
];

const a_6: AmongTable = [
    ["ic", 1],
    ["abil", 1],
    ["iv", 1]
];

const a_7: AmongTable = [
    ["ica", 1],
    ["logia", 3],
    ["osa", 1],
    ["ista", 1],
    ["iva", 9],
    ["anza", 1],
    ["enza", 5],
    ["ice", 1],
    ["atrice", 1, 1],
    ["iche", 1],
    ["logie", 3],
    ["abile", 1],
    ["ibile", 1],
    ["usione", 4],
    ["azione", 2],
    ["uzione", 4],
    ["atore", 2],
    ["ose", 1],
    ["ante", 1],
    ["mente", 1],
    ["amente", 7, 1],
    ["iste", 1],
    ["ive", 9],
    ["anze", 1],
    ["enze", 5],
    ["ici", 1],
    ["atrici", 1, 1],
    ["ichi", 1],
    ["abili", 1],
    ["ibili", 1],
    ["ismi", 1],
    ["usioni", 4],
    ["azioni", 2],
    ["uzioni", 4],
    ["atori", 2],
    ["osi", 1],
    ["anti", 1],
    ["amenti", 6],
    ["imenti", 6],
    ["isti", 1],
    ["ivi", 9],
    ["ico", 1],
    ["ismo", 1],
    ["oso", 1],
    ["amento", 6],
    ["imento", 6],
    ["ivo", 9],
    ["it\u00E0", 8],
    ["ist\u00E0", 1],
    ["ist\u00E8", 1],
    ["ist\u00EC", 1]
];

const a_8: AmongTable = [
    ["isca", 1],
    ["enda", 1],
    ["ata", 1],
    ["ita", 1],
    ["uta", 1],
    ["ava", 1],
    ["eva", 1],
    ["iva", 1],
    ["erebbe", 1],
    ["irebbe", 1],
    ["isce", 1],
    ["ende", 1],
    ["are", 1],
    ["ere", 1],
    ["ire", 1],
    ["asse", 1],
    ["ate", 1],
    ["avate", 1, 1],
    ["evate", 1, 2],
    ["ivate", 1, 3],
    ["ete", 1],
    ["erete", 1, 1],
    ["irete", 1, 2],
    ["ite", 1],
    ["ereste", 1],
    ["ireste", 1],
    ["ute", 1],
    ["erai", 1],
    ["irai", 1],
    ["isci", 1],
    ["endi", 1],
    ["erei", 1],
    ["irei", 1],
    ["assi", 1],
    ["ati", 1],
    ["iti", 1],
    ["eresti", 1],
    ["iresti", 1],
    ["uti", 1],
    ["avi", 1],
    ["evi", 1],
    ["ivi", 1],
    ["isco", 1],
    ["ando", 1],
    ["endo", 1],
    ["Yamo", 1],
    ["iamo", 1],
    ["avamo", 1],
    ["evamo", 1],
    ["ivamo", 1],
    ["eremo", 1],
    ["iremo", 1],
    ["assimo", 1],
    ["ammo", 1],
    ["emmo", 1],
    ["eremmo", 1, 1],
    ["iremmo", 1, 2],
    ["immo", 1],
    ["ano", 1],
    ["iscano", 1, 1],
    ["avano", 1, 2],
    ["evano", 1, 3],
    ["ivano", 1, 4],
    ["eranno", 1],
    ["iranno", 1],
    ["ono", 1],
    ["iscono", 1, 1],
    ["arono", 1, 2],
    ["erono", 1, 3],
    ["irono", 1, 4],
    ["erebbero", 1],
    ["irebbero", 1],
    ["assero", 1],
    ["essero", 1],
    ["issero", 1],
    ["ato", 1],
    ["ito", 1],
    ["uto", 1],
    ["avo", 1],
    ["evo", 1],
    ["ivo", 1],
    ["ar", 1],
    ["ir", 1],
    ["er\u00E0", 1],
    ["ir\u00E0", 1],
    ["er\u00F2", 1],
    ["ir\u00F2", 1]
];

const g_v: readonly number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2, 1];

const g_AEIO: readonly number[] = [17, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2];

const g_CG: readonly number[] = [17];


export class ItalianStemmer extends BaseStemmer {

    #I_p2 = 0;
    #I_p1 = 0;
    #I_pV = 0;


    /** @return {boolean} */
    #r_elisions() {
        this.bra = this.c;
        if (this.find_among(a_0) === 0) return false;
        this.ket = this.c;
        if (this.c >= this.limit) return false;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_prelude() {
        let a: number;
        const v_1 = this.c;
        while (true) {
            const v_2 = this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                this.bra = this.c;
                a = this.find_among(a_1);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("\u00E0");
                        break;
                    }
                    case 2: {
                        this.slice_from("\u00E8");
                        break;
                    }
                    case 3: {
                        this.slice_from("\u00EC");
                        break;
                    }
                    case 4: {
                        this.slice_from("\u00F2");
                        break;
                    }
                    case 5: {
                        this.slice_from("\u00F9");
                        break;
                    }
                    case 6: {
                        this.slice_from("qU");
                        break;
                    }
                    case 7: {
                        if (this.c >= this.limit) break lab0;
                        this.c++;
                        break;
                    }
                }
                continue;
            }
            this.c = v_2;
            break;
        }
        this.c = v_1;
        while (true) {
            const v_3 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                // deno-lint-ignore no-unused-labels
                golab2: while (true)
                {
                    const v_4 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        if (!(this.in_grouping(g_v, 97, 249))) break lab3;
                        this.bra = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            const v_5 = this.c;
                            // deno-lint-ignore no-unused-labels
                            lab5: {
                                if (!(this.eq_s("u"))) break lab5;
                                this.ket = this.c;
                                if (!(this.in_grouping(g_v, 97, 249))) break lab5;
                                this.slice_from("U");
                                break lab4;
                            }
                            this.c = v_5;
                            if (!(this.eq_s("i"))) break lab3;
                            this.ket = this.c;
                            if (!(this.in_grouping(g_v, 97, 249))) break lab3;
                            this.slice_from("I");
                        }
                        this.c = v_4;
                        break golab2;
                    }
                    this.c = v_4;
                    if (this.c >= this.limit) break lab1;
                    this.c++;
                }
                continue;
            }
            this.c = v_3;
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
                    if (!(this.in_grouping(g_v, 97, 249))) break lab2;
                    // deno-lint-ignore no-unused-labels
                    lab3: {
                        const v_3 = this.c;
                        // deno-lint-ignore no-unused-labels
                        lab4: {
                            if (!(this.out_grouping(g_v, 97, 249))) break lab4;
                            if (!this.go_out_grouping(g_v, 97, 249)) break lab4;
                            this.c++;
                            break lab3;
                        }
                        this.c = v_3;
                        if (!(this.in_grouping(g_v, 97, 249))) break lab2;
                        if (!this.go_in_grouping(g_v, 97, 249)) break lab2;
                        this.c++;
                    }
                    break lab1;
                }
                this.c = v_2;
                // deno-lint-ignore no-unused-labels
                lab5: {
                    if (!(this.eq_s("divan"))) break lab5;
                    break lab1;
                }
                this.c = v_2;
                if (!(this.out_grouping(g_v, 97, 249))) break lab0;
                // deno-lint-ignore no-unused-labels
                lab6: {
                    const v_4 = this.c;
                    // deno-lint-ignore no-unused-labels
                    lab7: {
                        if (!(this.out_grouping(g_v, 97, 249))) break lab7;
                        if (!this.go_out_grouping(g_v, 97, 249)) break lab7;
                        this.c++;
                        break lab6;
                    }
                    this.c = v_4;
                    if (!(this.in_grouping(g_v, 97, 249))) break lab0;
                    if (this.c >= this.limit) break lab0;
                    this.c++;
                }
            }
            this.#I_pV = this.c;
        }
        this.c = v_1;
        const v_5 = this.c;
        // deno-lint-ignore no-unused-labels
        lab8: {
            if (!this.go_out_grouping(g_v, 97, 249)) break lab8;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 249)) break lab8;
            this.c++;
            this.#I_p1 = this.c;
            if (!this.go_out_grouping(g_v, 97, 249)) break lab8;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 249)) break lab8;
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
                a = this.find_among(a_2);
                this.ket = this.c;
                switch (a) {
                    case 1: {
                        this.slice_from("i");
                        break;
                    }
                    case 2: {
                        this.slice_from("u");
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
    #r_attached_pronoun() {
        let a: number;
        this.ket = this.c;
        if (this.find_among_b(a_3) === 0) return false;
        this.bra = this.c;
        a = this.find_among_b(a_4);
        if (a === 0) return false;
        if (!this.#r_RV()) return false;
        this.slice_from(substitution(as_4, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_standard_suffix() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_7);
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
                if (!this.#r_RV()) return false;
                this.slice_del();
                break;
            }
            case 7: {
                if (this.#I_p1 > this.c) return false;
                this.slice_del();
                const v_2 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab1: {
                    this.ket = this.c;
                    a = this.find_among_b(a_5);
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
            case 8: {
                if (!this.#r_R2()) return false;
                this.slice_del();
                const v_3 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    this.ket = this.c;
                    if (this.find_among_b(a_6) === 0) {
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
            case 9: {
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
                    this.ket = this.c;
                    if (!(this.eq_s_b("ic"))) {
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
        }
        return true;
    }

    /** @return {boolean} */
    #r_verb_suffix() {
        if (this.c < this.#I_pV) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_pV;
        this.ket = this.c;
        if (this.find_among_b(a_8) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.slice_del();
        this.limit_backward = v_1;
        return true;
    }

    /** @return {boolean} */
    #r_vowel_suffix() {
        const v_1 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            this.ket = this.c;
            if (!(this.in_grouping_b(g_AEIO, 97, 242))) {
                this.c = this.limit - v_1;
                break lab0;
            }
            this.bra = this.c;
            if (!this.#r_RV()) {
                this.c = this.limit - v_1;
                break lab0;
            }
            this.slice_del();
            this.ket = this.c;
            if (!(this.eq_s_b("i"))) {
                this.c = this.limit - v_1;
                break lab0;
            }
            this.bra = this.c;
            if (!this.#r_RV()) {
                this.c = this.limit - v_1;
                break lab0;
            }
            this.slice_del();
        }
        const v_2 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab1: {
            this.ket = this.c;
            if (!(this.eq_s_b("h"))) {
                this.c = this.limit - v_2;
                break lab1;
            }
            this.bra = this.c;
            if (!(this.in_grouping_b(g_CG, 99, 103))) {
                this.c = this.limit - v_2;
                break lab1;
            }
            if (!this.#r_RV()) {
                this.c = this.limit - v_2;
                break lab1;
            }
            this.slice_del();
        }
        return true;
    }

    /** @return {boolean} */
    #stem() {
        const v_1 = this.c;
        this.#r_elisions();
        this.c = v_1;
        const v_2 = this.c;
        this.#r_prelude();
        this.c = v_2;
        this.#r_mark_regions();
        this.limit_backward = this.c; this.c = this.limit;
        const v_3 = this.limit - this.c;
        this.#r_attached_pronoun();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            // deno-lint-ignore no-unused-labels
            lab1: {
                const v_5 = this.limit - this.c;
                // deno-lint-ignore no-unused-labels
                lab2: {
                    if (!this.#r_standard_suffix()) break lab2;
                    break lab1;
                }
                this.c = this.limit - v_5;
                if (!this.#r_verb_suffix()) break lab0;
            }
        }
        this.c = this.limit - v_4;
        const v_6 = this.limit - this.c;
        this.#r_vowel_suffix();
        this.c = this.limit - v_6;
        this.c = this.limit_backward;
        const v_7 = this.c;
        this.#r_postlude();
        this.c = v_7;
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
