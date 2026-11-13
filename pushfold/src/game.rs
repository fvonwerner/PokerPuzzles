//! The push/fold game: seats, blinds and antes, decision points, side pots and
//! the payoff of every possible end of the hand.

use crate::icm;
use serde::{Deserialize, Serialize};

pub const ALL_SEATS: [&str; 6] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
pub const MAX_PLAYERS: usize = 6;

// ----------------------------------------------------------------------------
// Spot specification (the JSON input).

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Free text kept with the output (e.g. the chip counts behind the bb stacks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub players: usize,
    /// Stacks in big blinds before posting, in action order (seats_for(players)).
    pub stacks: Vec<f64>,
    #[serde(default)]
    pub ante: AnteSpec,
    #[serde(default)]
    pub blinds: BlindSpec,
    pub payoff: PayoffSpec,
    #[serde(default)]
    pub accuracy: AccuracySpec,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AnteSpec {
    /// No ante at all.
    None,
    /// Every player posts `amount` bb (league default 0.1 = 10% of the big blind).
    PerPlayer {
        #[serde(default = "default_player_ante")]
        amount: f64,
    },
    /// The big blind posts one ante of `amount` bb for the table (none heads-up).
    BbAnte {
        #[serde(default = "default_bb_ante")]
        amount: f64,
    },
}
fn default_player_ante() -> f64 {
    0.1
}
fn default_bb_ante() -> f64 {
    1.0
}
impl Default for AnteSpec {
    fn default() -> Self {
        AnteSpec::PerPlayer { amount: 0.1 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BlindSpec {
    pub sb: f64,
    pub bb: f64,
}
impl Default for BlindSpec {
    fn default() -> Self {
        BlindSpec { sb: 0.5, bb: 1.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum PayoffSpec {
    /// Chip EV in big blinds.
    Chips,
    /// League points by ICM (Malmuth-Harville). Default payouts: the first N of
    /// 15/8/5/3/2/1.
    Points {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payouts: Option<Vec<f64>>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AccuracySpec {
    /// Stop when the in-sample exploitability (max over players, per hand) is at
    /// or below this. Units: bb for chips, points for points. None = automatic:
    /// 0.002 bb, or 0.002 bb times the average points per bb on the table.
    pub target_exploitability: Option<f64>,
    pub max_iterations: usize,
    /// Monte Carlo: complete deals (board + all hands) in the solving sample.
    pub solve_deals: usize,
    /// Monte Carlo: deals in the independent evaluation sample.
    pub eval_deals: usize,
    /// Monte Carlo: iterations after the fixed-sample phase, each on a fresh
    /// sample of `refine_deals` deals; the final strategy averages these.
    pub refine_iterations: usize,
    pub refine_deals: usize,
    pub seed: u64,
    /// "auto" (exact heads-up, Monte Carlo otherwise), "exact" or "mc".
    pub method: String,
}
impl Default for AccuracySpec {
    fn default() -> Self {
        AccuracySpec {
            target_exploitability: None,
            max_iterations: 2000,
            solve_deals: 400_000,
            eval_deals: 2_000_000,
            refine_iterations: 0,
            refine_deals: 100_000,
            seed: 1,
            method: "auto".into(),
        }
    }
}

pub fn seats_for(n: usize) -> Vec<&'static str> {
    ALL_SEATS[MAX_PLAYERS - n..].to_vec()
}

// ----------------------------------------------------------------------------
// The table after posting.

#[derive(Clone, Debug)]
pub struct Table {
    pub n: usize,
    pub seats: Vec<&'static str>,
    pub stacks: Vec<f64>,
    /// Posted chips that count as a live contribution (antes in per-player mode,
    /// blinds).
    pub live_posted: Vec<f64>,
    /// Posted dead money (the big blind ante).
    pub dead_posted: Vec<f64>,
    /// All-in by posting alone: no decision.
    pub forced: Vec<bool>,
    pub sb: usize,
    pub bb: usize,
    /// None = chip EV; Some = points for places 1..=n.
    pub payouts: Option<Vec<f64>>,
}

impl Table {
    pub fn from_spec(spec: &Spec) -> Result<Table, String> {
        let n = spec.players;
        if !(2..=MAX_PLAYERS).contains(&n) {
            return Err(format!("players must be 2..=6, got {n}"));
        }
        if spec.stacks.len() != n {
            return Err(format!("{} stacks for {} players", spec.stacks.len(), n));
        }
        if spec.stacks.iter().any(|&s| !(s > 0.0) || !s.is_finite()) {
            return Err("stacks must be positive".into());
        }
        let seats = seats_for(n);
        let (sb, bb) = (n - 2, n - 1);
        let mut live = vec![0.0; n];
        let mut dead = vec![0.0; n];
        let blind = |i: usize| -> f64 {
            if i == sb {
                spec.blinds.sb
            } else if i == bb {
                spec.blinds.bb
            } else {
                0.0
            }
        };
        for i in 0..n {
            let s = spec.stacks[i];
            match spec.ante {
                AnteSpec::None => live[i] = blind(i).min(s),
                AnteSpec::PerPlayer { amount } => {
                    // ante first (it is dead money in practice, but every player
                    // posts the same ante so counting it in the side-pot levels is
                    // equivalent, and it is exact for a stack shorter than the ante)
                    let a = amount.min(s);
                    live[i] = a + blind(i).min(s - a);
                }
                AnteSpec::BbAnte { amount } => {
                    // blind first, then the table ante as dead money (TDA rule)
                    let b = blind(i).min(s);
                    live[i] = b;
                    if i == bb && n > 2 {
                        dead[i] = amount.min(s - b);
                    }
                }
            }
        }
        let forced: Vec<bool> = (0..n).map(|i| spec.stacks[i] - live[i] - dead[i] <= 1e-12).collect();
        let payouts = match &spec.payoff {
            PayoffSpec::Chips => None,
            PayoffSpec::Points { payouts } => {
                let p = payouts.clone().unwrap_or_else(|| icm::LEAGUE_POINTS.to_vec());
                if p.len() < n {
                    return Err(format!("{} payouts for {} players", p.len(), n));
                }
                Some(p[..n].to_vec())
            }
        };
        Ok(Table { n, seats, stacks: spec.stacks.clone(), live_posted: live, dead_posted: dead, forced, sb, bb, payouts })
    }

    pub fn total_chips(&self) -> f64 {
        self.stacks.iter().sum()
    }

    /// Does player p have a decision when the earlier voluntary all-ins are `facing`?
    pub fn has_decision(&self, p: usize, facing: u32) -> bool {
        !self.forced[p] && !(p == self.bb && facing == 0)
    }

    /// Non-folded players and every player's live contribution at the end of a
    /// hand where the players in `v` went all-in voluntarily.
    pub fn contributions(&self, v: u32) -> (u32, [f64; MAX_PLAYERS]) {
        let mut live = [0.0; MAX_PLAYERS];
        let mut in_hand = 0u32;
        let bb_acted = v & !(1 << self.bb) != 0 && !self.forced[self.bb];
        for i in 0..self.n {
            let allin = v & (1 << i) != 0 || self.forced[i];
            if allin {
                live[i] = self.stacks[i] - self.dead_posted[i];
                in_hand |= 1 << i;
            } else {
                live[i] = self.live_posted[i];
                if i == self.bb && !bb_acted {
                    in_hand |= 1 << i; // checked his blind
                }
            }
        }
        (in_hand, live)
    }

    /// Final stacks. `level[i]` ranks the hands of the non-folded players
    /// (0 = best; equal levels split).
    pub fn settle(&self, v: u32, level: &[u8; MAX_PLAYERS]) -> [f64; MAX_PLAYERS] {
        let n = self.n;
        let (in_hand, live) = self.contributions(v);
        let mut levels: Vec<f64> = (0..n).filter(|&i| in_hand & (1 << i) != 0).map(|i| live[i]).collect();
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap());
        levels.dedup();
        let dead_total: f64 = self.dead_posted.iter().sum();
        let mut won = [0.0; MAX_PLAYERS];
        let mut prev = 0.0;
        for (k, &l) in levels.iter().enumerate() {
            let mut pot = 0.0;
            for i in 0..n {
                pot += live[i].min(l) - live[i].min(prev);
            }
            if k == 0 {
                pot += dead_total;
            }
            let mut best = u8::MAX;
            for i in 0..n {
                if in_hand & (1 << i) != 0 && live[i] >= l {
                    best = best.min(level[i]);
                }
            }
            let winners: Vec<usize> =
                (0..n).filter(|&i| in_hand & (1 << i) != 0 && live[i] >= l && level[i] == best).collect();
            let share = pot / winners.len() as f64;
            for &w in &winners {
                won[w] += share;
            }
            prev = l;
        }
        let mut fin = [0.0; MAX_PLAYERS];
        for i in 0..n {
            let excess = (live[i] - prev).max(0.0);
            fin[i] = self.stacks[i] - live[i] - self.dead_posted[i] + won[i] + excess;
            if fin[i].abs() < 1e-12 {
                fin[i] = 0.0;
            }
        }
        fin
    }

    /// Payoff of every player for final stacks: bb won/lost, or league points.
    pub fn payoff(&self, fin: &[f64; MAX_PLAYERS]) -> [f64; MAX_PLAYERS] {
        let mut out = [0.0; MAX_PLAYERS];
        match &self.payouts {
            None => {
                for i in 0..self.n {
                    out[i] = fin[i] - self.stacks[i];
                }
            }
            Some(p) => {
                let pts = icm::points_after_hand(&fin[..self.n], &self.stacks, p);
                out[..self.n].copy_from_slice(&pts);
            }
        }
        out
    }

    /// Payoff of folding everything (no all-in at all) for reference: the
    /// value of the hand when every player folds to the big blind.
    pub fn payoff_units(&self) -> &'static str {
        if self.payouts.is_some() {
            "points"
        } else {
            "bb"
        }
    }

    /// Total points on offer (points mode) — the payoffs sum to this.
    pub fn total_points(&self) -> f64 {
        self.payouts.as_ref().map(|p| p.iter().sum()).unwrap_or(0.0)
    }
}

// ----------------------------------------------------------------------------
// Decision points.

#[derive(Clone, Debug)]
pub struct InfoSet {
    pub player: usize,
    /// Earlier voluntary all-ins, as a bitmask over players.
    pub facing: u32,
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub infosets: Vec<InfoSet>,
    /// id[p * 64 + facing] = infoset id, or -1
    pub id: Vec<i32>,
}

impl Tree {
    pub fn new(t: &Table) -> Tree {
        let mut infosets = Vec::new();
        let mut id = vec![-1i32; t.n * 64];
        for p in 0..t.n {
            if t.forced[p] {
                continue;
            }
            // earlier players who can act
            let earlier: Vec<usize> = (0..p).filter(|&j| !t.forced[j]).collect();
            let mut masks: Vec<u32> = (0..1u32 << earlier.len())
                .map(|sub| {
                    let mut m = 0u32;
                    for (k, &j) in earlier.iter().enumerate() {
                        if sub & (1 << k) != 0 {
                            m |= 1 << j;
                        }
                    }
                    m
                })
                .filter(|&m| t.has_decision(p, m))
                .collect();
            masks.sort_by_key(|&m| (m.count_ones(), m));
            for m in masks {
                id[p * 64 + m as usize] = infosets.len() as i32;
                infosets.push(InfoSet { player: p, facing: m });
            }
        }
        Tree { infosets, id }
    }

    #[inline]
    pub fn get(&self, p: usize, facing: u32) -> i32 {
        self.id[p * 64 + facing as usize]
    }
}

// ----------------------------------------------------------------------------
// Payoff tables: for every end of the hand (the set v of voluntary all-ins) and
// every weak ordering of the non-folded players' hands, the payoff vector.

#[derive(Clone, Debug)]
pub struct Terminal {
    #[allow(dead_code)] // read by tests
    pub valid: bool,
    #[allow(dead_code)] // kept for inspection
    pub in_hand: u32,
    /// non-folded players in seat order
    pub members: Vec<u8>,
    pub offset: usize,
}

pub struct Payoffs {
    pub n: usize,
    pub terms: Vec<Terminal>,
    /// [(offset + encoding) * n + player]
    pub values: Vec<f64>,
    pub pow: [[usize; 7]; 7],
}

impl Payoffs {
    pub fn new(t: &Table) -> Payoffs {
        let n = t.n;
        let mut pow = [[0usize; 7]; 7];
        for k in 1..=6 {
            pow[k][0] = 1;
            for e in 1..7 {
                pow[k][e] = pow[k][e - 1] * k;
            }
        }
        let mut terms = Vec::with_capacity(1 << n);
        let mut values = Vec::new();
        for v in 0..(1u32 << n) {
            let mut valid = true;
            for i in 0..n {
                if v & (1 << i) != 0 && t.forced[i] {
                    valid = false;
                }
            }
            if v & (1 << t.bb) != 0 && v & !(1 << t.bb) == 0 {
                valid = false; // the big blind cannot call nothing
            }
            if !valid {
                terms.push(Terminal { valid: false, in_hand: 0, members: vec![], offset: 0 });
                continue;
            }
            let (in_hand, _) = t.contributions(v);
            let members: Vec<u8> = (0..n as u8).filter(|&i| in_hand & (1 << i) != 0).collect();
            let k = members.len();
            let offset = values.len() / n;
            let size = if k <= 1 { 1 } else { pow[k][k] };
            values.resize(values.len() + size * n, f64::NAN);
            for enc in 0..size {
                let mut lv = [0u8; MAX_PLAYERS];
                let mut used = [false; MAX_PLAYERS];
                let mut e = enc;
                for &m in &members {
                    let l = if k <= 1 { 0 } else { e % k };
                    if k > 1 {
                        e /= k;
                    }
                    lv[m as usize] = l as u8;
                    used[l] = true;
                }
                // dense: levels used are exactly 0..=max
                let maxl = members.iter().map(|&m| lv[m as usize]).max().unwrap_or(0) as usize;
                if (0..=maxl).any(|l| !used[l]) {
                    continue;
                }
                let fin = t.settle(v, &lv);
                let pay = t.payoff(&fin);
                values[(offset + enc) * n..(offset + enc + 1) * n].copy_from_slice(&pay[..n]);
            }
            terms.push(Terminal { valid: true, in_hand, members, offset });
        }
        Payoffs { n, terms, values, pow }
    }

    /// Encoding of a weak ordering given each member's key (smaller = better).
    #[inline]
    pub fn encode(&self, term: &Terminal, key: &[u8; MAX_PLAYERS]) -> usize {
        let k = term.members.len();
        if k <= 1 {
            return 0;
        }
        let mut enc = 0usize;
        for (t, &m) in term.members.iter().enumerate() {
            let km = key[m as usize];
            // dense level = number of distinct smaller keys among members
            let mut seen = 0u32; // bitmask of keys (keys < 32)
            for &o in term.members.iter() {
                let ko = key[o as usize];
                if ko < km {
                    seen |= 1 << ko;
                }
            }
            enc += seen.count_ones() as usize * self.pow[k][t];
        }
        enc
    }

    #[inline]
    pub fn value(&self, term: &Terminal, enc: usize, player: usize) -> f64 {
        self.values[(term.offset + enc) * self.n + player]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(n: usize, stacks: Vec<f64>, ante: AnteSpec, payoff: PayoffSpec) -> Spec {
        Spec {
            name: None,
            note: None,
            players: n,
            stacks,
            ante,
            blinds: BlindSpec::default(),
            payoff,
            accuracy: AccuracySpec::default(),
        }
    }

    #[test]
    fn seat_order_for_every_n() {
        assert_eq!(seats_for(2), vec!["SB", "BB"]);
        assert_eq!(seats_for(3), vec!["BTN", "SB", "BB"]);
        assert_eq!(seats_for(4), vec!["CO", "BTN", "SB", "BB"]);
        assert_eq!(seats_for(5), vec!["HJ", "CO", "BTN", "SB", "BB"]);
        assert_eq!(seats_for(6), vec!["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
        for n in 2..=6 {
            let t = Table::from_spec(&spec(n, vec![10.0; n], AnteSpec::default(), PayoffSpec::Chips)).unwrap();
            assert_eq!(t.sb, n - 2);
            assert_eq!(t.bb, n - 1);
            let tree = Tree::new(&t);
            // decision points: 2^p for player p, minus the BB's unopened pot
            let expected: usize = (0..n).map(|p| 1usize << p).sum::<usize>() - 1;
            assert_eq!(tree.infosets.len(), expected, "n={n}");
            // the first decision is the first seat's, unopened
            assert_eq!(tree.infosets[0].player, 0);
            assert_eq!(tree.infosets[0].facing, 0);
        }
    }

    #[test]
    fn posting_per_player_ante() {
        let t = Table::from_spec(&spec(6, vec![10.0; 6], AnteSpec::default(), PayoffSpec::Chips)).unwrap();
        let expect = [0.1, 0.1, 0.1, 0.1, 0.6, 1.1];
        for i in 0..6 {
            assert!((t.live_posted[i] - expect[i]).abs() < 1e-12);
            assert_eq!(t.dead_posted[i], 0.0);
        }
        // everyone folds: BB wins the five other antes (0.5) and the SB (0.5)
        let fin = t.settle(0, &[0; 6]);
        let pay = t.payoff(&fin);
        assert!((pay[5] - 1.0).abs() < 1e-12);
        assert!((pay[4] + 0.6).abs() < 1e-12);
        assert!((pay[0] + 0.1).abs() < 1e-12);
        // heads-up: SB 0.6, BB 1.1
        let t = Table::from_spec(&spec(2, vec![10.0; 2], AnteSpec::default(), PayoffSpec::Chips)).unwrap();
        assert!((t.live_posted[0] - 0.6).abs() < 1e-12 && (t.live_posted[1] - 1.1).abs() < 1e-12);
    }

    #[test]
    fn posting_bb_ante_and_short_stacks() {
        let t = Table::from_spec(&spec(4, vec![10.0, 10.0, 10.0, 10.0], AnteSpec::BbAnte { amount: 1.0 }, PayoffSpec::Chips))
            .unwrap();
        assert_eq!(t.live_posted, vec![0.0, 0.0, 0.5, 1.0]);
        assert_eq!(t.dead_posted, vec![0.0, 0.0, 0.0, 1.0]);
        // everyone folds: BB nets the SB
        let pay = t.payoff(&t.settle(0, &[0; 6]));
        assert!((pay[3] - 0.5).abs() < 1e-12);
        // no BB ante heads-up
        let t = Table::from_spec(&spec(2, vec![10.0, 10.0], AnteSpec::BbAnte { amount: 1.0 }, PayoffSpec::Chips)).unwrap();
        assert_eq!(t.dead_posted, vec![0.0, 0.0]);
        // BB with 1.5: blind 1 first, then 0.5 ante, forced all-in
        let t = Table::from_spec(&spec(3, vec![10.0, 10.0, 1.5], AnteSpec::BbAnte { amount: 1.0 }, PayoffSpec::Chips)).unwrap();
        assert_eq!(t.live_posted[2], 1.0);
        assert_eq!(t.dead_posted[2], 0.5);
        assert!(t.forced[2]);
        // per-player ante with a stack shorter than ante + blind
        let t = Table::from_spec(&spec(3, vec![10.0, 0.4, 10.0], AnteSpec::default(), PayoffSpec::Chips)).unwrap();
        assert!((t.live_posted[1] - 0.4).abs() < 1e-12 && t.forced[1]);
        let tree = Tree::new(&t);
        // SB forced: BTN has 1 decision, BB faces BTN's jam only
        assert_eq!(tree.infosets.len(), 2);
    }

    #[test]
    fn side_pots_three_way_unequal() {
        // BTN 5, SB 10, BB 20 (no ante). All in. Contributions 5, 10, 20.
        let t = Table::from_spec(&spec(3, vec![5.0, 10.0, 20.0], AnteSpec::None, PayoffSpec::Chips)).unwrap();
        let v = 0b111;
        // BTN best, SB second: BTN wins main 15, SB wins side 10, BB gets 10 back.
        let fin = t.settle(v, &[0, 1, 2, 0, 0, 0]);
        assert_eq!(&fin[..3], &[15.0, 10.0, 10.0]);
        // BB best: wins everything.
        let fin = t.settle(v, &[1, 2, 0, 0, 0, 0]);
        assert_eq!(&fin[..3], &[0.0, 0.0, 35.0]);
        // BTN and SB tie for best: split main 15 (7.5 each), SB wins side 10.
        let fin = t.settle(v, &[0, 0, 1, 0, 0, 0]);
        assert_eq!(&fin[..3], &[7.5, 17.5, 10.0]);
        // SB best, BTN second: SB wins main + side = 25, BB gets 10 back, BTN 0.
        let fin = t.settle(v, &[1, 0, 2, 0, 0, 0]);
        assert_eq!(&fin[..3], &[0.0, 25.0, 10.0]);
        // Only BTN and BB in (SB folds 0.5): main = 5 + 5 + 0.5.
        let fin = t.settle(0b101, &[0, 0, 1, 0, 0, 0]);
        assert_eq!(&fin[..3], &[10.5, 9.5, 15.0]);
    }

    #[test]
    fn side_pots_with_antes_and_uncalled_excess() {
        // 4 players, per-player ante 0.1: CO 3, BTN 8, SB 12, BB 2.
        let t = Table::from_spec(&spec(4, vec![3.0, 8.0, 12.0, 2.0], AnteSpec::default(), PayoffSpec::Chips)).unwrap();
        // CO jams, SB calls (all-in 12), BB calls (2). BTN folds (0.1 ante).
        let v = 0b1101;
        // BB best, then CO, then SB.
        let fin = t.settle(v, &[1, 0, 2, 0, 0, 0]);
        // main (level 2): 2 + 2 + 2 + 0.1 = 6.1 -> BB; level 3: 1 + 1 = 2 -> CO;
        // level 12: SB's 9 uncalled -> back to SB.
        assert!((fin[3] - 6.1).abs() < 1e-12);
        assert!((fin[0] - 2.0).abs() < 1e-12);
        assert!((fin[2] - 9.0).abs() < 1e-12);
        assert!((fin[1] - 7.9).abs() < 1e-12);
        let total: f64 = fin[..4].iter().sum();
        assert!((total - 25.0).abs() < 1e-12);
    }

    #[test]
    fn bb_ante_is_dead_money_in_the_main_pot() {
        // BTN 10, SB 10, BB 10, BB ante 1. BTN jams, BB calls, SB folds.
        let t = Table::from_spec(&spec(3, vec![10.0, 10.0, 10.0], AnteSpec::BbAnte { amount: 1.0 }, PayoffSpec::Chips))
            .unwrap();
        // BB's live stack is 9, so BTN risks 9; main = 9 + 9 + 0.5 + 1 dead = 19.5.
        let fin = t.settle(0b101, &[0, 0, 1, 0, 0, 0]);
        assert!((fin[0] - 20.5).abs() < 1e-12); // 1 back + 19.5
        assert_eq!(fin[2], 0.0);
        assert!((fin[1] - 9.5).abs() < 1e-12);
    }

    #[test]
    fn payoffs_conserve_chips_and_points() {
        for &(n, ref stacks) in &[(3usize, vec![4.0, 9.5, 13.0]), (6, vec![5.0, 12.0, 7.5, 7.5, 2.0, 15.0])] {
            for payoff in [PayoffSpec::Chips, PayoffSpec::Points { payouts: None }] {
                for ante in [AnteSpec::default(), AnteSpec::BbAnte { amount: 1.0 }, AnteSpec::None] {
                    let t = Table::from_spec(&spec(n, stacks.clone(), ante, payoff.clone())).unwrap();
                    let p = Payoffs::new(&t);
                    let target = if t.payouts.is_some() { t.total_points() } else { 0.0 };
                    for term in &p.terms {
                        if !term.valid {
                            continue;
                        }
                        let k = term.members.len();
                        let size = if k <= 1 { 1 } else { p.pow[k][k] };
                        for enc in 0..size {
                            if p.values[(term.offset + enc) * n].is_nan() {
                                continue;
                            }
                            let s: f64 = (0..n).map(|i| p.value(term, enc, i)).sum();
                            assert!((s - target).abs() < 1e-9, "sum {s} target {target}");
                        }
                    }
                }
            }
        }
    }
}
