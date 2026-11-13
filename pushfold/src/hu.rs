//! Exact heads-up engine.
//!
//! All-in equities are exact: for every pair of hand classes we count, over all
//! C(52,5) boards (enumerated as 134,459 suit-isomorphism classes with their
//! multiplicities) and all pairs of disjoint combos, the boards on which each
//! hand wins or ties. Card removal between the two hands is therefore exact.
//! The equilibrium is found with CFR+ on the 2 x 169 decisions and the
//! exploitability is an exact best-response computation.

use crate::cards::{class_size, combos, NUM_CLASSES, NUM_COMBOS};
use crate::eval::eval7;
use crate::game::{Payoffs, Table, Tree, MAX_PLAYERS};
use crate::solution::{DecisionResult, Solution};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

pub const BOARDS_PER_PAIR: u64 = 1_712_304; // C(48, 5)

/// Suit-isomorphism classes of 5-card boards: (cards, multiplicity).
pub fn canonical_boards() -> &'static Vec<([u8; 5], u32)> {
    static B: OnceLock<Vec<([u8; 5], u32)>> = OnceLock::new();
    B.get_or_init(|| {
        let mut perms: Vec<[u8; 4]> = Vec::new();
        for a in 0..4u8 {
            for b in 0..4u8 {
                for c in 0..4u8 {
                    for d in 0..4u8 {
                        let p = [a, b, c, d];
                        let mut seen = [false; 4];
                        if p.iter().all(|&x| !std::mem::replace(&mut seen[x as usize], true)) {
                            perms.push(p);
                        }
                    }
                }
            }
        }
        let mut map: HashMap<u32, ([u8; 5], u32)> = HashMap::new();
        for a in 0..52u8 {
            for b in a + 1..52 {
                for c in b + 1..52 {
                    for d in c + 1..52 {
                        for e in d + 1..52 {
                            let board = [a, b, c, d, e];
                            let mut best = u32::MAX;
                            for p in &perms {
                                let mut x: [u8; 5] = board.map(|card| (card & !3) | p[(card & 3) as usize]);
                                x.sort_unstable();
                                let key = x.iter().fold(0u32, |k, &card| k * 52 + card as u32);
                                best = best.min(key);
                            }
                            map.entry(best).or_insert((board, 0)).1 += 1;
                        }
                    }
                }
            }
        }
        let mut v: Vec<([u8; 5], u32)> = map.into_values().collect();
        v.sort_unstable();
        v
    })
}

/// Exact class-vs-class all-in statistics.
pub struct ClassPairs {
    /// number of disjoint combo pairs (class i combo, class j combo)
    pub pairs: Vec<u64>,
    /// boards won by class i against class j, summed over disjoint combo pairs
    pub wins: Vec<u64>,
    /// boards tied
    pub ties: Vec<u64>,
}

impl ClassPairs {
    #[inline]
    pub fn idx(i: usize, j: usize) -> usize {
        i * NUM_CLASSES + j
    }
    /// P(class i wins), P(tie), given a random disjoint combo pair of the classes.
    pub fn probs(&self, i: usize, j: usize) -> (f64, f64) {
        let k = Self::idx(i, j);
        let tot = self.pairs[k] as f64 * BOARDS_PER_PAIR as f64;
        (self.wins[k] as f64 / tot, self.ties[k] as f64 / tot)
    }
}

pub fn class_pairs() -> &'static ClassPairs {
    static P: OnceLock<ClassPairs> = OnceLock::new();
    P.get_or_init(compute_class_pairs)
}

fn compute_class_pairs() -> ClassPairs {
    let t0 = Instant::now();
    let cmb = combos();
    let boards = canonical_boards();
    let mut pairs = vec![0u64; NUM_CLASSES * NUM_CLASSES];
    for c in 0..NUM_COMBOS {
        for x in 0..NUM_COMBOS {
            if cmb.mask[c] & cmb.mask[x] == 0 {
                pairs[ClassPairs::idx(cmb.class_of[c] as usize, cmb.class_of[x] as usize)] += 1;
            }
        }
    }
    let chunk = 512;
    let (wins, ties) = boards
        .par_chunks(chunk)
        .map(|bs| {
            let mut wins = vec![0u64; NUM_CLASSES * NUM_CLASSES];
            let mut ties = vec![0u64; NUM_CLASSES * NUM_CLASSES];
            let mut rank = vec![u32::MAX; NUM_COMBOS];
            let mut order: Vec<(u32, u16)> = Vec::with_capacity(NUM_COMBOS);
            let mut cnt = [0u64; NUM_CLASSES];
            for &(board, w) in bs {
                let w = w as u64;
                let bmask: u64 = board.iter().fold(0, |m, &c| m | (1u64 << c));
                let bbits: u64 = board.iter().fold(0, |m, &c| m | crate::cards::eval_bit(c));
                order.clear();
                for id in 0..NUM_COMBOS {
                    if cmb.mask[id] & bmask != 0 {
                        rank[id] = u32::MAX;
                        continue;
                    }
                    let r = eval7(bbits | cmb.ebits[id]);
                    rank[id] = r;
                    order.push((r, id as u16));
                }
                order.sort_unstable();
                cnt.iter_mut().for_each(|c| *c = 0);
                let mut g = 0;
                while g < order.len() {
                    let r = order[g].0;
                    let mut e = g;
                    while e < order.len() && order[e].0 == r {
                        e += 1;
                    }
                    for gi in g..e {
                        let c = order[gi].1 as usize;
                        let row = cmb.class_of[c] as usize * NUM_CLASSES;
                        for (k, &n) in cnt.iter().enumerate() {
                            wins[row + k] += w * n;
                        }
                        // remove beaten combos that share a card with c
                        let (a, b) = cmb.cards[c];
                        for &card in &[a, b] {
                            for &x in &cmb.with_card[card as usize] {
                                let x = x as usize;
                                if x != c && rank[x] < r {
                                    wins[row + cmb.class_of[x] as usize] -= w;
                                }
                            }
                        }
                        for gj in g..e {
                            let x = order[gj].1 as usize;
                            if x != c && cmb.mask[x] & cmb.mask[c] == 0 {
                                ties[row + cmb.class_of[x] as usize] += w;
                            }
                        }
                    }
                    for gi in g..e {
                        cnt[cmb.class_of[order[gi].1 as usize] as usize] += 1;
                    }
                    g = e;
                }
            }
            (wins, ties)
        })
        .reduce(
            || (vec![0u64; NUM_CLASSES * NUM_CLASSES], vec![0u64; NUM_CLASSES * NUM_CLASSES]),
            |(mut w1, mut t1), (w2, t2)| {
                for k in 0..w1.len() {
                    w1[k] += w2[k];
                    t1[k] += t2[k];
                }
                (w1, t1)
            },
        );
    // Every disjoint pair on every board is a win, a tie or a loss.
    for i in 0..NUM_CLASSES {
        for j in 0..NUM_CLASSES {
            let k = ClassPairs::idx(i, j);
            let k2 = ClassPairs::idx(j, i);
            assert_eq!(ties[k], ties[k2]);
            assert_eq!(wins[k] + ties[k] + wins[k2], pairs[k] * BOARDS_PER_PAIR, "classes {i} {j}");
        }
    }
    eprintln!("[hu] exact class-pair equities over {} board classes in {:.1}s", boards.len(), t0.elapsed().as_secs_f64());
    ClassPairs { pairs, wins, ties }
}

/// Exact equity of two specific hands (all boards enumerated): (win, tie).
#[allow(dead_code)] // used by tests
pub fn exact_two_hand(h1: (u8, u8), h2: (u8, u8)) -> (f64, f64) {
    let used = (1u64 << h1.0) | (1u64 << h1.1) | (1u64 << h2.0) | (1u64 << h2.1);
    let deck: Vec<u8> = (0..52u8).filter(|&c| used & (1u64 << c) == 0).collect();
    let b1 = crate::cards::eval_bit(h1.0) | crate::cards::eval_bit(h1.1);
    let b2 = crate::cards::eval_bit(h2.0) | crate::cards::eval_bit(h2.1);
    let bits: Vec<u64> = deck.iter().map(|&c| crate::cards::eval_bit(c)).collect();
    let (mut w, mut t, mut n) = (0u64, 0u64, 0u64);
    let m = bits.len();
    for a in 0..m {
        for b in a + 1..m {
            for c in b + 1..m {
                for d in c + 1..m {
                    let x = bits[a] | bits[b] | bits[c] | bits[d];
                    for e in d + 1..m {
                        let board = x | bits[e];
                        let (r1, r2) = (eval7(board | b1), eval7(board | b2));
                        n += 1;
                        if r1 > r2 {
                            w += 1;
                        } else if r1 == r2 {
                            t += 1;
                        }
                    }
                }
            }
        }
    }
    (w as f64 / n as f64, t as f64 / n as f64)
}

// ----------------------------------------------------------------------------
// Solver

/// The heads-up game reduced to class-pair arithmetic: every payoff of the hand
/// is one of a few constants, so the counterfactual values are sums over the
/// exact class-pair statistics.
struct HuGame {
    tree: Tree,
    sb_dec: i32,
    bb_dec: i32,
    /// disjoint combo pairs per (sb class, bb class)
    n: Vec<f64>,
    /// n * SB's payoff when the hand is shown down (SB jams, BB calls or is all-in)
    sd_sb: Vec<f64>,
    sd_bb: Vec<f64>,
    u_sb_fold: f64,
    u_sb_steal: f64,
    u_bb_fold: f64,
}

impl HuGame {
    fn new(table: &Table) -> HuGame {
        let pay = Payoffs::new(table);
        let tree = Tree::new(table);
        let cp = class_pairs();
        let (sbp, bbp) = (0usize, 1usize);
        let sb_dec = tree.get(sbp, 0);
        let bb_dec = tree.get(bbp, 1 << sbp);
        let val = |v: u32, ksb: u8, kbb: u8, player: usize| {
            let tm = &pay.terms[v as usize];
            let mut key = [0u8; MAX_PLAYERS];
            key[sbp] = ksb;
            key[bbp] = kbb;
            pay.value(tm, pay.encode(tm, &key), player)
        };
        let jam_v: u32 = 1 << sbp;
        // the hand is shown down when SB jams and BB calls; when BB is all-in by
        // posting a jam is always shown down; when SB is all-in by posting the
        // hand is shown down with no voluntary action at all
        let show_v: u32 = if sb_dec < 0 {
            0
        } else if bb_dec >= 0 {
            (1 << sbp) | (1 << bbp)
        } else {
            jam_v
        };
        let u_sb_fold = if sb_dec >= 0 { val(0, 0, 0, sbp) } else { 0.0 };
        let u_steal = |p| if bb_dec >= 0 { val(jam_v, 0, 0, p) } else { 0.0 };
        let (u_sb_steal, u_bb_fold) = (u_steal(sbp), u_steal(bbp));
        let sb_show = [val(show_v, 0, 1, sbp), val(show_v, 0, 0, sbp), val(show_v, 1, 0, sbp)];
        let bb_show = [val(show_v, 0, 1, bbp), val(show_v, 0, 0, bbp), val(show_v, 1, 0, bbp)];
        let mut n = vec![0.0; NUM_CLASSES * NUM_CLASSES];
        let mut sd_sb = vec![0.0; NUM_CLASSES * NUM_CLASSES];
        let mut sd_bb = vec![0.0; NUM_CLASSES * NUM_CLASSES];
        for h1 in 0..NUM_CLASSES {
            for h2 in 0..NUM_CLASSES {
                let k = ClassPairs::idx(h1, h2);
                n[k] = cp.pairs[k] as f64;
                if cp.pairs[k] == 0 {
                    continue;
                }
                let (pw, pt) = cp.probs(h1, h2);
                let pl = 1.0 - pw - pt;
                sd_sb[k] = n[k] * (pw * sb_show[0] + pt * sb_show[1] + pl * sb_show[2]);
                sd_bb[k] = n[k] * (pw * bb_show[0] + pt * bb_show[1] + pl * bb_show[2]);
            }
        }
        HuGame { tree, sb_dec, bb_dec, n, sd_sb, sd_bb, u_sb_fold, u_sb_steal, u_bb_fold }
    }
}

/// Counterfactual values (summed over combo pairs) of every decision and class
/// for strategy `s` (all-in probability per infoset and class): [fold, allin], reach.
fn hu_values(g: &HuGame, s: &[Vec<f64>]) -> (Vec<Vec<[f64; 2]>>, Vec<Vec<f64>>) {
    let ni = g.tree.infosets.len();
    let mut cf = vec![vec![[0.0f64; 2]; NUM_CLASSES]; ni];
    let mut reach = vec![vec![0.0f64; NUM_CLASSES]; ni];
    if g.sb_dec >= 0 {
        let i = g.sb_dec as usize;
        for h1 in 0..NUM_CLASSES {
            let (mut tot, mut jam) = (0.0, 0.0);
            for h2 in 0..NUM_CLASSES {
                let k = h1 * NUM_CLASSES + h2;
                let n = g.n[k];
                tot += n;
                jam += if g.bb_dec >= 0 {
                    let c = s[g.bb_dec as usize][h2];
                    (1.0 - c) * n * g.u_sb_steal + c * g.sd_sb[k]
                } else {
                    g.sd_sb[k]
                };
            }
            cf[i][h1] = [tot * g.u_sb_fold, jam];
            reach[i][h1] = tot;
        }
    }
    if g.bb_dec >= 0 {
        let i = g.bb_dec as usize;
        let sj = |h1: usize| if g.sb_dec >= 0 { s[g.sb_dec as usize][h1] } else { 1.0 };
        let mut call = [0.0f64; NUM_CLASSES];
        let mut r = [0.0f64; NUM_CLASSES];
        for h1 in 0..NUM_CLASSES {
            let p = sj(h1);
            if p == 0.0 {
                continue;
            }
            for h2 in 0..NUM_CLASSES {
                let k = h1 * NUM_CLASSES + h2;
                call[h2] += p * g.sd_bb[k];
                r[h2] += p * g.n[k];
            }
        }
        for h2 in 0..NUM_CLASSES {
            cf[i][h2] = [r[h2] * g.u_bb_fold, call[h2]];
            reach[i][h2] = r[h2];
        }
    }
    (cf, reach)
}

pub fn solve_hu(table: &Table, target: f64, max_iter: usize) -> Solution {
    let t0 = Instant::now();
    assert_eq!(table.n, 2);
    let g = HuGame::new(table);
    let ni = g.tree.infosets.len();
    let norm = (NUM_COMBOS * (NUM_COMBOS - 101)) as f64; // 1326 * 1225 ordered disjoint pairs
    let mut cur = vec![vec![0.5f64; NUM_CLASSES]; ni];
    let mut regret = vec![vec![[0.0f64; 2]; NUM_CLASSES]; ni];
    let mut avg_num = vec![vec![0.0f64; NUM_CLASSES]; ni];
    let mut avg_den = 0.0f64;
    let mut it = 0;
    let mut avg = cur.clone();
    let mut exploit;
    while it < max_iter {
        it += 1;
        let (cf, _) = hu_values(&g, &cur);
        let w = it as f64;
        for i in 0..ni {
            for h in 0..NUM_CLASSES {
                let s = cur[i][h];
                avg_num[i][h] += w * s;
                let v = s * cf[i][h][1] + (1.0 - s) * cf[i][h][0];
                let r = &mut regret[i][h];
                r[0] = (r[0] + cf[i][h][0] - v).max(0.0);
                r[1] = (r[1] + cf[i][h][1] - v).max(0.0);
                let sum = r[0] + r[1];
                cur[i][h] = if sum > 0.0 { r[1] / sum } else { 0.5 };
            }
        }
        avg_den += w;
        if it % 100 == 0 {
            for i in 0..ni {
                for h in 0..NUM_CLASSES {
                    avg[i][h] = avg_num[i][h] / avg_den;
                }
            }
            exploit = exploitability(&g, &avg, norm);
            if exploit.iter().cloned().fold(0.0, f64::max) <= target {
                break;
            }
        }
    }
    for i in 0..ni {
        for h in 0..NUM_CLASSES {
            avg[i][h] = avg_num[i][h] / avg_den;
        }
    }
    exploit = exploitability(&g, &avg, norm);
    let (cf, reach) = hu_values(&g, &avg);
    let mut decisions = Vec::new();
    for (i, info) in g.tree.infosets.iter().enumerate() {
        let mut d = DecisionResult::new(info.clone());
        let mut tot_reach = 0.0;
        for h in 0..NUM_CLASSES {
            d.freq[h] = avg[i][h];
            let r = reach[i][h];
            tot_reach += r;
            // P(reaching this decision | holding class h)
            d.class_reach[h] = r / (class_size(h) as f64 * (NUM_COMBOS - 101) as f64);
            if r > 0.0 {
                d.ev_fold[h] = cf[i][h][0] / r;
                d.ev_allin[h] = cf[i][h][1] / r;
            } else {
                d.ev_fold[h] = f64::NAN;
                d.ev_allin[h] = f64::NAN;
            }
            d.samples[h] = f64::INFINITY;
        }
        d.reach = tot_reach / norm;
        decisions.push(d);
    }
    // player EVs (per hand) under the final strategies
    let mut pev = vec![0.0; 2];
    {
        // value of the hand for each player: sum over class pairs
        let sb = |h1: usize| if g.sb_dec >= 0 { avg[g.sb_dec as usize][h1] } else { 1.0 };
        let bb = |h2: usize| if g.bb_dec >= 0 { avg[g.bb_dec as usize][h2] } else { 1.0 };
        let pay = Payoffs::new(table);
        let fold_all = &pay.terms[0];
        let u_fold = [pay.value(fold_all, 0, 0), pay.value(fold_all, 0, 1)];
        let steal = if g.bb_dec >= 0 { [g.u_sb_steal, g.u_bb_fold] } else { [0.0, 0.0] };
        for h1 in 0..NUM_CLASSES {
            for h2 in 0..NUM_CLASSES {
                let k = h1 * NUM_CLASSES + h2;
                let n = g.n[k];
                if n == 0.0 {
                    continue;
                }
                let (j, c) = (sb(h1), bb(h2));
                let jam_sb = (1.0 - c) * n * steal[0] + c * g.sd_sb[k];
                let jam_bb = (1.0 - c) * n * steal[1] + c * g.sd_bb[k];
                if g.sb_dec >= 0 {
                    pev[0] += (1.0 - j) * n * u_fold[0] + j * jam_sb;
                    pev[1] += (1.0 - j) * n * u_fold[1] + j * jam_bb;
                } else {
                    pev[0] += jam_sb;
                    pev[1] += jam_bb;
                }
            }
        }
        for p in pev.iter_mut() {
            *p /= norm;
        }
    }
    let mut sol = Solution::new(table, "exact-hu", it, t0.elapsed().as_secs_f64());
    sol.decisions = decisions;
    sol.exploit_in_sample = exploit.clone();
    sol.exploit_eval = exploit.clone();
    sol.exploit_eval_se = vec![0.0; 2];
    sol.exploit_eval_crossfit = exploit;
    sol.player_ev = pev;
    sol.player_ev_se = vec![0.0; 2];
    sol.equity_method = "exact: every board enumerated for every pair of hands (class-pair win/tie counts over the 134,459 suit-isomorphic board classes); card removal between the two hands exact".into();
    sol.equity_error = 0.0;
    sol
}

/// Exact gain of a best response, per player, per hand.
fn exploitability(g: &HuGame, s: &[Vec<f64>], norm: f64) -> Vec<f64> {
    let (cf, _) = hu_values(g, s);
    let mut gain = vec![0.0f64; 2];
    for (i, info) in g.tree.infosets.iter().enumerate() {
        for h in 0..NUM_CLASSES {
            let [f, a] = cf[i][h];
            let v = s[i][h] * a + (1.0 - s[i][h]) * f;
            gain[info.player] += f.max(a) - v;
        }
    }
    gain.iter().map(|x| x / norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{class_index, parse_hand};

    #[test]
    fn canonical_boards_cover_all_boards() {
        let b = canonical_boards();
        assert_eq!(b.len(), 134_459);
        assert_eq!(b.iter().map(|x| x.1 as u64).sum::<u64>(), 2_598_960);
    }

    #[test]
    fn class_pairs_match_direct_enumeration() {
        let cp = class_pairs();
        // AA vs KK: average over all 36 suit combinations of exact equities
        let aa = class_index("AA").unwrap();
        let kk = class_index("KK").unwrap();
        let cm = combos();
        let (mut w, mut t) = (0.0, 0.0);
        for &c in &cm.class_combos[aa] {
            for &x in &cm.class_combos[kk] {
                let (a, b) = cm.cards[c as usize];
                let (d, e) = cm.cards[x as usize];
                let (pw, pt) = exact_two_hand((a, b), (d, e));
                w += pw;
                t += pt;
            }
        }
        let (pw, pt) = cp.probs(aa, kk);
        assert!((pw - w / 36.0).abs() < 1e-12, "{pw} {}", w / 36.0);
        assert!((pt - t / 36.0).abs() < 1e-12);
        // a specific hand: AhAs vs KdKc
        let (pw, _) = exact_two_hand(parse_hand("AhAs").unwrap(), parse_hand("KdKc").unwrap());
        assert!(pw > 0.80 && pw < 0.84, "{pw}");
    }
}
