//! Monte Carlo engine over complete deals.
//!
//! A sample is a list of complete deals drawn from one shuffled deck: the board
//! and every player's hole cards. For each deal and each player ("hero") the
//! hero's own two cards are replaced by every combo of the cards nobody else
//! holds (hero enumeration), so each deal yields an exact average over the
//! hero's possible hands given everybody else's cards and the board. Because the
//! deal is complete, every card-removal effect is in it: the hero's blockers,
//! the other players' cards blocking each other (also the cards of players who
//! fold, which skews the remaining deck), and the board coming from what is left
//! of the deck. Multi-way all-ins and side pots are settled exactly on the board.
//! The only error is sampling error, which is measured.

use crate::cards::{combo_id, combos, draw, eval_bit, Rng, NUM_CLASSES};
use crate::eval::{eval7, ordinal};
use crate::game::{Payoffs, Table, Tree, MAX_PLAYERS};
use rayon::prelude::*;

pub const NC: usize = NUM_CLASSES;
const SLOTS: usize = 2 * MAX_PLAYERS + 1;

pub struct Mc<'a> {
    pub t: &'a Table,
    pub tree: Tree,
    pub pay: Payoffs,
    pub n: usize,
    pub ni: usize,
    /// hero combos per deal: C(49 - 2N, 2)
    pub c_free: usize,
}

struct Scratch {
    deck: [u8; 52],
    hist: Vec<u16>,
    touched: Vec<u16>,
    dcount: [u16; NC],
    dclasses: Vec<u8>,
    own: Vec<Vec<(u8, u8)>>,
    reach: Vec<(u32, f64)>,
    vjam: Vec<f64>,
}

impl Scratch {
    fn new() -> Self {
        Scratch {
            deck: [0; 52],
            hist: vec![0; NC * SLOTS],
            touched: Vec::with_capacity(NC * SLOTS),
            dcount: [0; NC],
            dclasses: Vec::with_capacity(NC),
            own: vec![Vec::with_capacity(128); MAX_PLAYERS],
            reach: Vec::with_capacity(64),
            vjam: vec![0.0; SLOTS],
        }
    }
}

/// Sums over a sample. `cf` layout: [(infoset * NC + class) * 3 + k], k = 0 fold
/// value, 1 all-in value, 2 reach. `pev`: per-player payoff of the actual deal.
#[derive(Clone)]
pub struct Acc {
    pub cf: Vec<f64>,
    pub pev: Vec<f64>,
    pub deals: u64,
    pub max_conservation_error: f64,
}

impl Acc {
    pub fn new(ni: usize, n: usize) -> Self {
        Acc { cf: vec![0.0; ni * NC * 3], pev: vec![0.0; n], deals: 0, max_conservation_error: 0.0 }
    }
    pub fn add(&mut self, o: &Acc) {
        for (a, b) in self.cf.iter_mut().zip(&o.cf) {
            *a += b;
        }
        for (a, b) in self.pev.iter_mut().zip(&o.pev) {
            *a += b;
        }
        self.deals += o.deals;
        self.max_conservation_error = self.max_conservation_error.max(o.max_conservation_error);
    }
}

#[inline]
fn slot(r: i32, u: &[i32]) -> usize {
    for (t, &v) in u.iter().enumerate() {
        if r > v {
            return 2 * t;
        }
        if r == v {
            return 2 * t + 1;
        }
    }
    2 * u.len()
}

fn binom2(m: usize) -> usize {
    m * (m - 1) / 2
}

impl<'a> Mc<'a> {
    pub fn new(t: &'a Table) -> Self {
        let tree = Tree::new(t);
        let ni = tree.infosets.len();
        Mc { t, pay: Payoffs::new(t), tree, n: t.n, ni, c_free: binom2(49 - 2 * t.n) }
    }

    /// One pass over deals `first..first+count` of the sample `seed`.
    pub fn pass(&self, seed: u64, first: u64, count: u64, strat: &[f64]) -> Acc {
        let chunk = 2000u64;
        let nchunks = count.div_ceil(chunk);
        // per-chunk sums are added in chunk order, so the result does not
        // depend on the number of threads or on scheduling
        let parts: Vec<Acc> = (0..nchunks)
            .into_par_iter()
            .map(|c| {
                let mut acc = Acc::new(self.ni, self.n);
                let mut sc = Scratch::new();
                let lo = first + c * chunk;
                let hi = (lo + chunk).min(first + count);
                for idx in lo..hi {
                    self.deal(seed, idx, strat, &mut acc, &mut sc);
                }
                acc
            })
            .collect();
        let mut total = Acc::new(self.ni, self.n);
        for p in &parts {
            total.add(p);
        }
        total
    }

    fn deal(&self, seed: u64, idx: u64, strat: &[f64], acc: &mut Acc, sc: &mut Scratch) {
        let n = self.n;
        let cm = combos();
        let mut rng = Rng::stream(seed, idx);
        for (i, c) in sc.deck.iter_mut().enumerate() {
            *c = i as u8;
        }
        let k = 5 + 2 * n;
        draw(&mut sc.deck, 52, k, &mut rng);
        let rl = 52 - k; // cards nobody holds and not on the board
        let mut rest = [0u8; 52];
        rest[..rl].copy_from_slice(&sc.deck[..rl]);
        let bbits = (0..5).fold(0u64, |m, t| m | eval_bit(sc.deck[rl + t]));
        let mut hands = [(0u8, 0u8); MAX_PLAYERS];
        let mut rank = [0i32; MAX_PLAYERS];
        let mut cls = [0usize; MAX_PLAYERS];
        for j in 0..n {
            let (a, b) = (sc.deck[rl + 5 + 2 * j], sc.deck[rl + 6 + 2 * j]);
            hands[j] = (a, b);
            let id = combo_id(a, b);
            cls[j] = cm.class_of[id] as usize;
            rank[j] = ordinal(eval7(bbits | cm.ebits[id])) as i32;
        }
        // distinct ranks of all players, best first
        let mut uall = [0i32; MAX_PLAYERS];
        let mut qa = 0;
        {
            let mut v: Vec<i32> = rank[..n].to_vec();
            v.sort_unstable_by(|a, b| b.cmp(a));
            v.dedup();
            qa = v.len().max(qa);
            uall[..qa].copy_from_slice(&v);
        }
        let ua = &uall[..qa];

        // 1. the actual deal: every player's payoff (and conservation check)
        {
            let mut key = [0u8; MAX_PLAYERS];
            for j in 0..n {
                key[j] = ua.iter().position(|&x| x == rank[j]).unwrap() as u8;
            }
            let mut out = [0.0f64; MAX_PLAYERS];
            self.full(0, 0, 1.0, &cls, strat, &key, &mut out);
            let target = if self.t.payouts.is_some() { self.t.total_points() } else { 0.0 };
            let s: f64 = out[..n].iter().sum();
            acc.max_conservation_error = acc.max_conservation_error.max((s - target).abs());
            for j in 0..n {
                acc.pev[j] += out[j];
            }
            acc.deals += 1;
        }

        // 2. histograms of the hero combos: combos of free deck cards (any hero)
        // and combos using a player's own cards (only that player as hero),
        // by class and by the slot of their rank among all players' ranks
        let mut rbits = [0u64; 52];
        for t in 0..rl {
            rbits[t] = eval_bit(rest[t]);
        }
        for a in 0..rl {
            let xa = bbits | rbits[a];
            let ca = rest[a];
            for b in a + 1..rl {
                let id = combo_id(ca, rest[b]);
                let cl = cm.class_of[id] as usize;
                let r = ordinal(eval7(xa | rbits[b])) as i32;
                let e = cl * SLOTS + slot(r, ua);
                if sc.hist[e] == 0 {
                    sc.touched.push(e as u16);
                }
                sc.hist[e] += 1;
                if sc.dcount[cl] == 0 {
                    sc.dclasses.push(cl as u8);
                }
                sc.dcount[cl] += 1;
            }
        }
        for j in 0..n {
            if self.t.forced[j] {
                continue;
            }
            let (a, b) = hands[j];
            let own = &mut sc.own[j];
            own.clear();
            for &x in &[a, b] {
                let xb = bbits | eval_bit(x);
                for t in 0..rl {
                    let id = combo_id(x, rest[t]);
                    let r = ordinal(eval7(xb | rbits[t])) as i32;
                    own.push((cm.class_of[id], slot(r, ua) as u8));
                }
            }
            own.push((cls[j] as u8, slot(rank[j], ua) as u8));
        }

        // 3. every player as hero
        for i in 0..n {
            if !self.t.forced[i] {
                self.hero(i, &rank, &cls, ua, strat, acc, sc);
            }
        }

        for &e in &sc.touched {
            sc.hist[e as usize] = 0;
        }
        sc.touched.clear();
        for &c in &sc.dclasses {
            sc.dcount[c as usize] = 0;
        }
        sc.dclasses.clear();
    }

    #[allow(clippy::too_many_arguments)]
    fn hero(&self, i: usize, rank: &[i32; MAX_PLAYERS], cls: &[usize; MAX_PLAYERS], ua: &[i32], strat: &[f64], acc: &mut Acc, sc: &mut Scratch) {
        let n = self.n;
        // distinct ranks of the other players, best first
        let mut ui = [0i32; MAX_PLAYERS];
        let mut qi = 0usize;
        for m in 0..n {
            if m == i {
                continue;
            }
            let r = rank[m];
            if ui[..qi].contains(&r) {
                continue;
            }
            let mut pos = qi;
            while pos > 0 && ui[pos - 1] < r {
                ui[pos] = ui[pos - 1];
                pos -= 1;
            }
            ui[pos] = r;
            qi += 1;
        }
        let mut key = [0u8; MAX_PLAYERS];
        for m in 0..n {
            if m != i {
                key[m] = (2 * ui[..qi].iter().position(|&x| x == rank[m]).unwrap() + 1) as u8;
            }
        }
        // slot among all players' ranks -> slot among the others' ranks
        let ui2: Vec<i32> = ui[..qi].iter().map(|&x| 2 * x).collect();
        let qa = ua.len();
        let mut map = [0usize; SLOTS];
        for (s, m) in map.iter_mut().enumerate().take(2 * qa + 1) {
            let t = s / 2;
            let v2 = if s % 2 == 1 {
                2 * ua[t]
            } else if t == 0 {
                2 * ua[0] + 1
            } else if t == qa {
                2 * ua[qa - 1] - 1
            } else {
                2 * ua[t] + 1
            };
            *m = slot(v2, &ui2);
        }
        let nslots = 2 * qi + 1;

        sc.reach.clear();
        self.earlier(i, 0, 0, 1.0, cls, strat, &mut sc.reach);
        for r in 0..sc.reach.len() {
            let (facing, pi) = sc.reach[r];
            let id = self.tree.get(i, facing);
            if id < 0 {
                continue; // the big blind's unopened pot: no decision
            }
            let base = id as usize * NC;
            let mut vfold = 0.0;
            for v in sc.vjam.iter_mut() {
                *v = 0.0;
            }
            let mut k2 = key;
            self.later(i, i + 1, facing, 1.0, false, cls, strat, &mut k2, nslots, &mut vfold, &mut sc.vjam);
            self.later(i, i + 1, facing | (1 << i), 1.0, true, cls, strat, &mut k2, nslots, &mut vfold, &mut sc.vjam);
            let cf = &mut acc.cf;
            for &e in &sc.touched {
                let e = e as usize;
                let cnt = sc.hist[e] as f64;
                let (cl, s) = (e / SLOTS, e % SLOTS);
                cf[(base + cl) * 3 + 1] += pi * cnt * sc.vjam[map[s]];
            }
            for &cl in &sc.dclasses {
                let c = sc.dcount[cl as usize] as f64 * pi;
                let o = (base + cl as usize) * 3;
                cf[o] += c * vfold;
                cf[o + 2] += c;
            }
            for &(cl, s) in &sc.own[i] {
                let o = (base + cl as usize) * 3;
                cf[o] += pi * vfold;
                cf[o + 1] += pi * sc.vjam[map[s as usize]];
                cf[o + 2] += pi;
            }
        }
    }

    /// Reachable sets of earlier voluntary all-ins before `hero`, with the
    /// probability the other players' actual hands produce them.
    #[allow(clippy::too_many_arguments)]
    fn earlier(&self, hero: usize, p: usize, mask: u32, prob: f64, cls: &[usize; MAX_PLAYERS], strat: &[f64], out: &mut Vec<(u32, f64)>) {
        if p == hero {
            out.push((mask, prob));
            return;
        }
        if self.t.forced[p] {
            return self.earlier(hero, p + 1, mask, prob, cls, strat, out);
        }
        let id = self.tree.get(p, mask) as usize;
        let s = strat[id * NC + cls[p]];
        if s > 0.0 {
            self.earlier(hero, p + 1, mask | (1 << p), prob * s, cls, strat, out);
        }
        if s < 1.0 {
            self.earlier(hero, p + 1, mask, prob * (1.0 - s), cls, strat, out);
        }
    }

    /// Expected payoff for `hero` over the actions of the players after him.
    #[allow(clippy::too_many_arguments)]
    fn later(
        &self,
        hero: usize,
        p: usize,
        v: u32,
        prob: f64,
        hero_in: bool,
        cls: &[usize; MAX_PLAYERS],
        strat: &[f64],
        key: &mut [u8; MAX_PLAYERS],
        nslots: usize,
        vfold: &mut f64,
        vjam: &mut [f64],
    ) {
        if p == self.n {
            let term = &self.pay.terms[v as usize];
            if hero_in {
                for (s, vj) in vjam.iter_mut().enumerate().take(nslots) {
                    key[hero] = s as u8;
                    let enc = self.pay.encode(term, key);
                    *vj += prob * self.pay.value(term, enc, hero);
                }
            } else {
                let enc = self.pay.encode(term, key);
                *vfold += prob * self.pay.value(term, enc, hero);
            }
            return;
        }
        let facing = v & ((1u32 << p) - 1);
        if self.t.forced[p] || !self.t.has_decision(p, facing) {
            return self.later(hero, p + 1, v, prob, hero_in, cls, strat, key, nslots, vfold, vjam);
        }
        let id = self.tree.get(p, facing) as usize;
        let s = strat[id * NC + cls[p]];
        if s > 0.0 {
            self.later(hero, p + 1, v | (1 << p), prob * s, hero_in, cls, strat, key, nslots, vfold, vjam);
        }
        if s < 1.0 {
            self.later(hero, p + 1, v, prob * (1.0 - s), hero_in, cls, strat, key, nslots, vfold, vjam);
        }
    }

    /// Expected payoff vector of the actual deal (all players' real hands).
    #[allow(clippy::too_many_arguments)]
    fn full(&self, p: usize, v: u32, prob: f64, cls: &[usize; MAX_PLAYERS], strat: &[f64], key: &[u8; MAX_PLAYERS], out: &mut [f64; MAX_PLAYERS]) {
        if p == self.n {
            let term = &self.pay.terms[v as usize];
            let enc = self.pay.encode(term, key);
            for (j, o) in out.iter_mut().enumerate().take(self.n) {
                *o += prob * self.pay.value(term, enc, j);
            }
            return;
        }
        if self.t.forced[p] || !self.t.has_decision(p, v) {
            return self.full(p + 1, v, prob, cls, strat, key, out);
        }
        let id = self.tree.get(p, v) as usize;
        let s = strat[id * NC + cls[p]];
        if s > 0.0 {
            self.full(p + 1, v | (1 << p), prob * s, cls, strat, key, out);
        }
        if s < 1.0 {
            self.full(p + 1, v, prob * (1.0 - s), cls, strat, key, out);
        }
    }
}
