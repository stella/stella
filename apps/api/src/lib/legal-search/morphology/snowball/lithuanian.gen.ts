/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  https://github.com/snowballstem/snowball
 * Version:   v3.1.1 (commit cd195b51e948a902a4312f023f4a14392516a543)
 * Command:   ./snowball algorithms/lithuanian.sbl -js -o lithuanian
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

// Generated from lithuanian.sbl by Snowball 3.1.1 - https://snowballstem.org/

// deno-lint-ignore-file ban-unused-ignore no-constant-condition no-empty prefer-const

const a_0: AmongTable = [
    ["a", -1],
    ["ia", -1, 1],
    ["osna", -1, 2],
    ["iosna", -1, 1],
    ["uosna", -1, 2],
    ["iuosna", -1, 1],
    ["ysna", -1, 6],
    ["\u0117sna", -1, 7],
    ["e", -1],
    ["ie", -1, 1],
    ["enie", -1, 1],
    ["oje", -1, 3],
    ["ioje", -1, 1],
    ["uje", -1, 5],
    ["iuje", -1, 1],
    ["yje", -1, 7],
    ["enyje", -1, 1],
    ["\u0117je", -1, 9],
    ["ame", -1, 10],
    ["iame", -1, 1],
    ["sime", -1, 12],
    ["ome", -1, 13],
    ["\u0117me", -1, 14],
    ["tum\u0117me", -1, 1],
    ["ose", -1, 16],
    ["iose", -1, 1],
    ["uose", -1, 2],
    ["iuose", -1, 1],
    ["yse", -1, 20],
    ["enyse", -1, 1],
    ["\u0117se", -1, 22],
    ["ate", -1, 23],
    ["iate", -1, 1],
    ["ite", -1, 25],
    ["kite", -1, 1],
    ["site", -1, 2],
    ["ote", -1, 28],
    ["tute", -1, 29],
    ["\u0117te", -1, 30],
    ["tum\u0117te", -1, 1],
    ["i", -1],
    ["ai", -1, 1],
    ["iai", -1, 1],
    ["ei", -1, 3],
    ["tumei", -1, 1],
    ["ki", -1, 5],
    ["imi", -1, 6],
    ["umi", -1, 7],
    ["iumi", -1, 1],
    ["si", -1, 9],
    ["asi", -1, 1],
    ["iasi", -1, 1],
    ["esi", -1, 3],
    ["iesi", -1, 1],
    ["siesi", -1, 1],
    ["isi", -1, 6],
    ["aisi", -1, 1],
    ["eisi", -1, 2],
    ["tumeisi", -1, 1],
    ["uisi", -1, 4],
    ["osi", -1, 11],
    ["\u0117josi", -1, 1],
    ["uosi", -1, 2],
    ["iuosi", -1, 1],
    ["siuosi", -1, 1],
    ["usi", -1, 16],
    ["ausi", -1, 1],
    ["\u010Diausi", -1, 1],
    ["\u0105si", -1, 19],
    ["\u0117si", -1, 20],
    ["\u0173si", -1, 21],
    ["t\u0173si", -1, 1],
    ["ti", -1, 32],
    ["enti", -1, 1],
    ["inti", -1, 2],
    ["oti", -1, 3],
    ["ioti", -1, 1],
    ["uoti", -1, 2],
    ["iuoti", -1, 1],
    ["auti", -1, 7],
    ["iauti", -1, 1],
    ["yti", -1, 9],
    ["\u0117ti", -1, 10],
    ["tel\u0117ti", -1, 1],
    ["in\u0117ti", -1, 2],
    ["ter\u0117ti", -1, 3],
    ["ui", -1, 46],
    ["iui", -1, 1],
    ["eniui", -1, 1],
    ["oj", -1],
    ["\u0117j", -1],
    ["k", -1],
    ["am", -1],
    ["iam", -1, 1],
    ["iem", -1],
    ["im", -1],
    ["sim", -1, 1],
    ["om", -1],
    ["tum", -1],
    ["\u0117m", -1],
    ["tum\u0117m", -1, 1],
    ["an", -1],
    ["on", -1],
    ["ion", -1, 1],
    ["un", -1],
    ["iun", -1, 1],
    ["\u0117n", -1],
    ["o", -1],
    ["io", -1, 1],
    ["enio", -1, 1],
    ["\u0117jo", -1, 3],
    ["uo", -1, 4],
    ["s", -1],
    ["as", -1, 1],
    ["ias", -1, 1],
    ["es", -1, 3],
    ["ies", -1, 1],
    ["is", -1, 5],
    ["ais", -1, 1],
    ["iais", -1, 1],
    ["tumeis", -1, 3],
    ["imis", -1, 4],
    ["enimis", -1, 1],
    ["omis", -1, 6],
    ["iomis", -1, 1],
    ["umis", -1, 8],
    ["\u0117mis", -1, 9],
    ["enis", -1, 10],
    ["asis", -1, 11],
    ["ysis", -1, 12],
    ["ams", -1, 18],
    ["iams", -1, 1],
    ["iems", -1, 20],
    ["ims", -1, 21],
    ["enims", -1, 1],
    ["oms", -1, 23],
    ["ioms", -1, 1],
    ["ums", -1, 25],
    ["\u0117ms", -1, 26],
    ["ens", -1, 27],
    ["os", -1, 28],
    ["ios", -1, 1],
    ["uos", -1, 2],
    ["iuos", -1, 1],
    ["us", -1, 32],
    ["aus", -1, 1],
    ["iaus", -1, 1],
    ["ius", -1, 3],
    ["ys", -1, 36],
    ["enys", -1, 1],
    ["\u0105s", -1, 38],
    ["i\u0105s", -1, 1],
    ["\u0117s", -1, 40],
    ["am\u0117s", -1, 1],
    ["iam\u0117s", -1, 1],
    ["im\u0117s", -1, 3],
    ["kim\u0117s", -1, 1],
    ["sim\u0117s", -1, 2],
    ["om\u0117s", -1, 6],
    ["\u0117m\u0117s", -1, 7],
    ["tum\u0117m\u0117s", -1, 1],
    ["at\u0117s", -1, 9],
    ["iat\u0117s", -1, 1],
    ["sit\u0117s", -1, 11],
    ["ot\u0117s", -1, 12],
    ["\u0117t\u0117s", -1, 13],
    ["tum\u0117t\u0117s", -1, 1],
    ["\u012Fs", -1, 55],
    ["\u016Bs", -1, 56],
    ["t\u0173s", -1, 57],
    ["at", -1],
    ["iat", -1, 1],
    ["it", -1],
    ["sit", -1, 1],
    ["ot", -1],
    ["\u0117t", -1],
    ["tum\u0117t", -1, 1],
    ["u", -1],
    ["au", -1, 1],
    ["iau", -1, 1],
    ["\u010Diau", -1, 1],
    ["iu", -1, 4],
    ["eniu", -1, 1],
    ["siu", -1, 2],
    ["y", -1],
    ["\u0105", -1],
    ["i\u0105", -1, 1],
    ["\u0117", -1],
    ["\u0119", -1],
    ["\u012F", -1],
    ["en\u012F", -1, 1],
    ["\u0173", -1],
    ["i\u0173", -1, 1]
];

const a_1: AmongTable = [
    ["ing", -1],
    ["aj", -1],
    ["iaj", -1, 1],
    ["iej", -1],
    ["oj", -1],
    ["ioj", -1, 1],
    ["uoj", -1, 2],
    ["iuoj", -1, 1],
    ["auj", -1],
    ["\u0105j", -1],
    ["i\u0105j", -1, 1],
    ["\u0117j", -1],
    ["\u0173j", -1],
    ["i\u0173j", -1, 1],
    ["ok", -1],
    ["iok", -1, 1],
    ["iuk", -1],
    ["uliuk", -1, 1],
    ["u\u010Diuk", -1, 2],
    ["i\u0161k", -1],
    ["iul", -1],
    ["yl", -1],
    ["\u0117l", -1],
    ["am", -1],
    ["dam", -1, 1],
    ["jam", -1, 2],
    ["zgan", -1],
    ["ain", -1],
    ["esn", -1],
    ["op", -1],
    ["iop", -1, 1],
    ["ias", -1],
    ["ies", -1],
    ["ais", -1],
    ["iais", -1, 1],
    ["os", -1],
    ["ios", -1, 1],
    ["uos", -1, 2],
    ["iuos", -1, 1],
    ["aus", -1],
    ["iaus", -1, 1],
    ["\u0105s", -1],
    ["i\u0105s", -1, 1],
    ["\u0119s", -1],
    ["ut\u0117ait", -1],
    ["ant", -1],
    ["iant", -1, 1],
    ["siant", -1, 1],
    ["int", -1],
    ["ot", -1],
    ["uot", -1, 1],
    ["iuot", -1, 1],
    ["yt", -1],
    ["\u0117t", -1],
    ["yk\u0161t", -1],
    ["iau", -1],
    ["dav", -1],
    ["sv", -1],
    ["\u0161v", -1],
    ["yk\u0161\u010D", -1],
    ["\u0119", -1],
    ["\u0117j\u0119", -1, 1]
];

const a_2: AmongTable = [
    ["ojime", 7],
    ["\u0117jime", 3],
    ["avime", 6],
    ["okate", 8],
    ["aite", 1],
    ["uote", 2],
    ["asius", 5],
    ["okat\u0117s", 8],
    ["ait\u0117s", 1],
    ["uot\u0117s", 2],
    ["esiu", 4]
];

const as_2: readonly string[] = ["ait\u0117", "uot\u0117", "\u0117jimas", "esys", "asys", "avimas", "ojimas", "okat\u0117"];

const a_3: AmongTable = [
    ["\u010D", 1],
    ["d\u017E", 2]
];

const as_3: readonly string[] = ["t", "d"];

const g_v: readonly number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 64, 1, 0, 64, 0, 0, 0, 0, 0, 0, 0, 4, 4];


export class LithuanianStemmer extends BaseStemmer {

    #I_p1 = 0;


    /** @return {boolean} */
    #r_step1() {
        if (this.c < this.#I_p1) return false;
        const v_1 = this.limit_backward;
        this.limit_backward = this.#I_p1;
        this.ket = this.c;
        if (this.find_among_b(a_0) === 0) {
            this.limit_backward = v_1;
            return false;
        }
        this.bra = this.c;
        this.limit_backward = v_1;
        this.slice_del();
        return true;
    }

    /** @return {boolean} */
    #r_step2() {
        while (true) {
            const v_1 = this.limit - this.c;
            // deno-lint-ignore no-unused-labels
            lab0: {
                if (this.c < this.#I_p1) break lab0;
                const v_2 = this.limit_backward;
                this.limit_backward = this.#I_p1;
                this.ket = this.c;
                if (this.find_among_b(a_1) === 0) {
                    this.limit_backward = v_2;
                    break lab0;
                }
                this.bra = this.c;
                this.limit_backward = v_2;
                this.slice_del();
                continue;
            }
            this.c = this.limit - v_1;
            break;
        }
        return true;
    }

    /** @return {boolean} */
    #r_fix_conflicts() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_2);
        if (a === 0) return false;
        this.bra = this.c;
        this.slice_from(substitution(as_2, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_fix_chdz() {
        let a: number;
        this.ket = this.c;
        a = this.find_among_b(a_3);
        if (a === 0) return false;
        this.bra = this.c;
        this.slice_from(substitution(as_3, a - 1));
        return true;
    }

    /** @return {boolean} */
    #r_fix_gd() {
        this.ket = this.c;
        if (!(this.eq_s_b("gd"))) return false;
        this.bra = this.c;
        this.slice_from("g");
        return true;
    }

    /** @return {boolean} */
    #stem() {
        this.#I_p1 = this.limit;
        const v_1 = this.c;
        // deno-lint-ignore no-unused-labels
        lab0: {
            const v_2 = this.c;
            // deno-lint-ignore no-unused-labels
            lab1: {
                if (!(this.eq_s("a"))) {
                    this.c = v_2;
                    break lab1;
                }
                if (this.current.length <= 6) {
                    this.c = v_2;
                    break lab1;
                }
            }
            if (!this.go_out_grouping(g_v, 97, 371)) break lab0;
            this.c++;
            if (!this.go_in_grouping(g_v, 97, 371)) break lab0;
            this.c++;
            this.#I_p1 = this.c;
        }
        this.c = v_1;
        this.limit_backward = this.c; this.c = this.limit;
        const v_3 = this.limit - this.c;
        this.#r_fix_conflicts();
        this.c = this.limit - v_3;
        const v_4 = this.limit - this.c;
        this.#r_step1();
        this.c = this.limit - v_4;
        const v_5 = this.limit - this.c;
        this.#r_fix_chdz();
        this.c = this.limit - v_5;
        const v_6 = this.limit - this.c;
        this.#r_step2();
        this.c = this.limit - v_6;
        const v_7 = this.limit - this.c;
        this.#r_fix_chdz();
        this.c = this.limit - v_7;
        const v_8 = this.limit - this.c;
        this.#r_fix_gd();
        this.c = this.limit - v_8;
        this.ket = this.c;
        if (!(this.eq_s_b("'"))) return false;
        this.bra = this.c;
        this.slice_del();
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
