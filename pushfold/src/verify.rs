//! Independent re-check of a solution by a second method.
//!
//! A plain simulation of the hand, written separately from the solver: its own
//! random generator and dealing, its own posting and side-pot settlement (pots
//! peeled off the smallest all-in), ICM by explicit enumeration of every
//! finishing order, the naive best-of-21 hand evaluator, and hand classes looked
//! up by name in the solution's own class list. For every deal and player it
//! plays the earlier players' actions at random from their strategies, then
//! values both of the player's actions exactly over the later players' mixed
//! strategies on the dealt cards and board. That gives, per decision and class,
//! the EV of folding and of going all-in with a plain best response, and the
//! players' overall EVs.

use crate::eval::naive7;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

const RANKS: &[u8] = b"23456789TJQKA";

/// PCG32 (O'Neill), independent of the solver's xoshiro generator.
struct Pcg(u64, u64);
impl Pcg {
    fn new(seed: u64, stream: u64) -> Pcg {
        let mut p = Pcg(0, (stream << 1) | 1);
        p.next();
        p.0 = p.0.wrapping_add(seed);
        p.next();
        p
    }
    fn next(&mut self) -> u32 {
        let old = self.0;
        self.0 = old.wrapping_mul(6364136223846793005).wrapping_add(self.1);
        let x = (((old >> 18) ^ old) >> 27) as u32;
        let r = (old >> 59) as u32;
        x.rotate_right(r)
    }
    fn below(&mut self, n: u32) -> u32 {
        // rejection sampling
        let lim = u32::MAX - u32::MAX % n;
        loop {
            let x = self.next();
            if x < lim {
                return x % n;
            }
        }
    }
    fn unit(&mut self) -> f64 {
        ((self.next() as u64) << 21 ^ (self.next() as u64)) as f64 / (1u64 << 53) as f64
    }
}

struct Game {
    n: usize,
    stacks: Vec<f64>,
    live: Vec<f64>,
    dead: Vec<f64>,
    allin_posted: Vec<bool>,
    payouts: Option<Vec<f64>>,
    classes: Vec<String>,
    /// strategy[(player, facing mask)] = all-in frequency per class index
    strat: HashMap<(usize, u32), Vec<f64>>,
    ev_ref: HashMap<(usize, u32), (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>)>,
}

fn class_name_of(a: u8, b: u8) -> String {
    let (ra, rb) = ((a >> 2) as usize, (b >> 2) as usize);
    let (hi, lo) = if ra >= rb { (ra, rb) } else { (rb, ra) };
    let mut s = String::new();
    s.push(RANKS[hi] as char);
    s.push(RANKS[lo] as char);
    if hi != lo {
        s.push(if a & 3 == b & 3 { 's' } else { 'o' });
    }
    s
}

impl Game {
    fn from_solution(v: &Value) -> Result<Game, String> {
        let spec = &v["spec"];
        let n = spec["players"].as_u64().ok_or("players")? as usize;
        let stacks: Vec<f64> = spec["stacks"].as_array().ok_or("stacks")?.iter().map(|x| x.as_f64().unwrap()).collect();
        let sbv = spec["blinds"]["sb"].as_f64().unwrap_or(0.5);
        let bbv = spec["blinds"]["bb"].as_f64().unwrap_or(1.0);
        let mode = spec["ante"]["mode"].as_str().unwrap_or("per_player").to_string();
        let amount = spec["ante"]["amount"].as_f64().unwrap_or(if mode == "bb_ante" { 1.0 } else { 0.1 });
        // posting, written out per seat: SB is the second-to-last seat, BB the last
        let mut live = vec![0.0; n];
        let mut dead = vec![0.0; n];
        for i in 0..n {
            let blind = if i + 2 == n { sbv } else if i + 1 == n { bbv } else { 0.0 };
            let mut left = stacks[i];
            if mode == "per_player" {
                let a = amount.min(left);
                live[i] += a;
                left -= a;
            }
            let b = blind.min(left);
            live[i] += b;
            left -= b;
            if mode == "bb_ante" && i + 1 == n && n > 2 {
                dead[i] = amount.min(left);
            }
        }
        let allin_posted: Vec<bool> = (0..n).map(|i| stacks[i] - live[i] - dead[i] <= 1e-12).collect();
        let payouts = if spec["payoff"]["model"] == "points" {
            let p: Vec<f64> = match spec["payoff"]["payouts"].as_array() {
                Some(a) => a.iter().map(|x| x.as_f64().unwrap()).collect(),
                None => vec![15.0, 8.0, 5.0, 3.0, 2.0, 1.0],
            };
            Some(p[..n].to_vec())
        } else {
            None
        };
        let classes: Vec<String> = v["classes"].as_array().ok_or("classes")?.iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let seats: Vec<String> = v["seats"].as_array().ok_or("seats")?.iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let mut strat = HashMap::new();
        let mut ev_ref = HashMap::new();
        for d in v["decisions"].as_array().ok_or("decisions")? {
            let p = d["position"].as_u64().unwrap() as usize;
            let mut mask = 0u32;
            for f in d["facing"].as_array().unwrap() {
                let j = seats.iter().position(|s| s == f.as_str().unwrap()).unwrap();
                mask |= 1 << j;
            }
            let f: Vec<f64> = d["freq"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
            strat.insert((p, mask), f);
            let g = |k: &str| d[k].as_array().unwrap().iter().map(|x| x.as_f64()).collect::<Vec<_>>();
            ev_ref.insert((p, mask), (g("ev_fold"), g("ev_allin"), g("ev_diff_se")));
        }
        Ok(Game { n, stacks, live, dead, allin_posted, payouts, classes, strat, ev_ref })
    }

    /// Final stacks: `allin` = players who put their whole stack in, `inhand` =
    /// players still holding cards, `val` = hand values (higher better).
    fn settle(&self, allin: u32, inhand: u32, val: &[u32]) -> Vec<f64> {
        let n = self.n;
        let mut put: Vec<f64> = (0..n).map(|i| if allin & (1 << i) != 0 { self.stacks[i] - self.dead[i] } else { self.live[i] }).collect();
        let mut fin: Vec<f64> = (0..n).map(|i| self.stacks[i] - put[i] - self.dead[i]).collect();
        let mut dead_money: f64 = self.dead.iter().sum();
        // peel pots off the smallest remaining contribution of a player in the hand
        loop {
            let contenders: Vec<usize> = (0..n).filter(|&i| inhand & (1 << i) != 0 && put[i] > 0.0).collect();
            if contenders.is_empty() {
                break;
            }
            let level = contenders.iter().map(|&i| put[i]).fold(f64::INFINITY, f64::min);
            let mut pot = dead_money;
            dead_money = 0.0;
            for p in put.iter_mut() {
                let take = p.min(level);
                pot += take;
                *p -= take;
            }
            let best = contenders.iter().map(|&i| val[i]).max().unwrap();
            let winners: Vec<usize> = contenders.iter().cloned().filter(|&i| val[i] == best).collect();
            for &w in &winners {
                fin[w] += pot / winners.len() as f64;
            }
        }
        // whatever nobody could win goes back
        for i in 0..n {
            fin[i] += put[i];
        }
        fin
    }

    fn payoff(&self, fin: &[f64], icm_cache: &mut HashMap<Vec<u64>, Vec<f64>>) -> Vec<f64> {
        match &self.payouts {
            None => (0..self.n).map(|i| fin[i] - self.stacks[i]).collect(),
            Some(p) => {
                let key: Vec<u64> = fin.iter().map(|x| ((x * 1e9).round()) as i64 as u64).collect();
                if let Some(v) = icm_cache.get(&key) {
                    return v.clone();
                }
                let v = icm_by_orders(fin, &self.stacks, p);
                icm_cache.insert(key, v.clone());
                v
            }
        }
    }
}

/// League points by enumerating every finishing order of the survivors
/// (Harville probabilities); busted players ranked by starting stack.
fn icm_by_orders(fin: &[f64], start: &[f64], pay: &[f64]) -> Vec<f64> {
    let n = fin.len();
    let alive: Vec<usize> = (0..n).filter(|&i| fin[i] > 1e-9).collect();
    let m = alive.len();
    let mut out = vec![0.0; n];
    // all permutations of the survivors
    let mut perm: Vec<usize> = alive.clone();
    let total: f64 = alive.iter().map(|&i| fin[i]).sum();
    fn rec(k: usize, perm: &mut Vec<usize>, fin: &[f64], total: f64, pay: &[f64], out: &mut [f64]) {
        if k == perm.len() {
            let mut p = 1.0;
            let mut left = total;
            for &i in perm.iter() {
                p *= fin[i] / left;
                left -= fin[i];
            }
            for (place, &i) in perm.iter().enumerate() {
                out[i] += p * pay[place];
            }
            return;
        }
        for j in k..perm.len() {
            perm.swap(k, j);
            rec(k + 1, perm, fin, total, pay, out);
            perm.swap(k, j);
        }
    }
    rec(0, &mut perm, fin, total, pay, &mut out);
    // busted: places m.. in order of starting stack, ties share
    let mut bust: Vec<usize> = (0..n).filter(|&i| fin[i] <= 1e-9).collect();
    bust.sort_by(|&a, &b| start[b].partial_cmp(&start[a]).unwrap());
    let mut k = 0;
    while k < bust.len() {
        let mut e = k;
        while e < bust.len() && (start[bust[e]] - start[bust[k]]).abs() < 1e-12 {
            e += 1;
        }
        let share = (k..e).map(|t| pay[m + t]).sum::<f64>() / (e - k) as f64;
        for t in k..e {
            out[bust[t]] = share;
        }
        k = e;
    }
    out
}

#[derive(Clone)]
struct Cell {
    n: f64,
    f: f64,
    a: f64,
    ff: f64,
    aa: f64,
    dd: f64,
}

struct Tally {
    cells: HashMap<(usize, u32, usize, u8), Cell>, // (player, facing, class, half)
    pev: Vec<f64>,
    pev2: Vec<f64>,
    deals: f64,
    max_cons: f64,
}

impl Game {
    /// Expected payoff of `who` over the actions of players p.. given the
    /// all-in set so far.
    #[allow(clippy::too_many_arguments)]
    fn rest(&self, p: usize, allin: u32, vol: u32, cls: &[usize], val: &[u32], cache: &mut HashMap<Vec<u64>, Vec<f64>>) -> Vec<f64> {
        let n = self.n;
        if p == n {
            // in hand: all-in players, plus the BB if nobody went all-in voluntarily
            // before him (he checked)
            let bb = n - 1;
            let mut inhand = allin;
            if vol & !(1 << bb) == 0 {
                inhand |= 1 << bb;
            }
            let fin = self.settle(allin, inhand, val);
            return self.payoff(&fin, cache);
        }
        if self.allin_posted[p] {
            return self.rest(p + 1, allin | (1 << p), vol, cls, val, cache);
        }
        if p == n - 1 && vol == 0 {
            return self.rest(p + 1, allin, vol, cls, val, cache); // BB checks
        }
        let s = self.strat[&(p, vol)][cls[p]];
        let mut out = vec![0.0; n];
        if s > 0.0 {
            let v = self.rest(p + 1, allin | (1 << p), vol | (1 << p), cls, val, cache);
            for i in 0..n {
                out[i] += s * v[i];
            }
        }
        if s < 1.0 {
            let v = self.rest(p + 1, allin, vol, cls, val, cache);
            for i in 0..n {
                out[i] += (1.0 - s) * v[i];
            }
        }
        out
    }
}

pub fn verify_cmd(args: &[String]) -> Result<(), String> {
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let path = get("--solution").ok_or("--solution required")?;
    let deals: u64 = get("--deals").and_then(|s| s.parse().ok()).unwrap_or(10_000_000);
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(2024);
    let out = get("--out").ok_or("--out required")?;
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let g = Game::from_solution(&v)?;
    let n = g.n;
    let t0 = std::time::Instant::now();
    let chunks = 400u64;
    let per = deals.div_ceil(chunks);
    let target = g.payouts.as_ref().map(|p| p.iter().sum::<f64>()).unwrap_or(0.0);
    let tallies: Vec<Tally> = (0..chunks)
        .into_par_iter()
        .map(|c| {
            let mut rng = Pcg::new(seed, c + 1);
            let mut cache = HashMap::new();
            let mut t = Tally { cells: HashMap::new(), pev: vec![0.0; n], pev2: vec![0.0; n], deals: 0.0, max_cons: 0.0 };
            let mut deck: Vec<u8> = (0..52).collect();
            for _ in 0..per {
                for i in 0..(5 + 2 * n) {
                    let j = i + rng.below((52 - i) as u32) as usize;
                    deck.swap(i, j);
                }
                let board = &deck[0..5];
                let mut cls = vec![0usize; n];
                let mut val = vec![0u32; n];
                for p in 0..n {
                    let (a, b) = (deck[5 + 2 * p], deck[6 + 2 * p]);
                    let name = class_name_of(a, b);
                    cls[p] = g.classes.iter().position(|x| *x == name).unwrap();
                    val[p] = naive7([board[0], board[1], board[2], board[3], board[4], a, b]);
                }
                // the whole hand, everybody playing his strategy (actions drawn)
                let mut allin = 0u32;
                let mut vol = 0u32;
                let mut path: Vec<(usize, u32)> = Vec::new(); // decision reached per player
                for p in 0..n {
                    if g.allin_posted[p] {
                        allin |= 1 << p;
                        continue;
                    }
                    if p == n - 1 && vol == 0 {
                        continue;
                    }
                    path.push((p, vol));
                    let s = g.strat[&(p, vol)][cls[p]];
                    if rng.unit() < s {
                        allin |= 1 << p;
                        vol |= 1 << p;
                    }
                }
                let bb = n - 1;
                let mut inhand = allin;
                if vol & !(1 << bb) == 0 {
                    inhand |= 1 << bb;
                }
                let fin = g.settle(allin, inhand, &val);
                let pay = g.payoff(&fin, &mut cache);
                let s: f64 = pay.iter().sum();
                t.max_cons = t.max_cons.max((s - target).abs());
                for i in 0..n {
                    t.pev[i] += pay[i];
                    t.pev2[i] += pay[i] * pay[i];
                }
                // each player at the decision he reached: value of both actions
                for &(p, facing) in &path {
                    let mut pre_allin = 0u32;
                    for j in 0..p {
                        if g.allin_posted[j] || facing & (1 << j) != 0 {
                            pre_allin |= 1 << j;
                        }
                    }
                    let vf = g.rest(p + 1, pre_allin, facing, &cls, &val, &mut cache)[p];
                    let va = g.rest(p + 1, pre_allin | (1 << p), facing | (1 << p), &cls, &val, &mut cache)[p];
                    let half = (t.deals as u64 % 2) as u8;
                    let e = t.cells.entry((p, facing, cls[p], half)).or_insert(Cell { n: 0.0, f: 0.0, a: 0.0, ff: 0.0, aa: 0.0, dd: 0.0 });
                    e.n += 1.0;
                    e.f += vf;
                    e.a += va;
                    e.ff += vf * vf;
                    e.aa += va * va;
                    e.dd += (va - vf) * (va - vf);
                }
                t.deals += 1.0;
            }
            t
        })
        .collect();
    // merge
    let mut cells: HashMap<(usize, u32, usize, u8), Cell> = HashMap::new();
    let mut pev = vec![0.0; n];
    let mut pev2 = vec![0.0; n];
    let mut total = 0.0;
    let mut max_cons: f64 = 0.0;
    for t in tallies {
        for (k, c) in t.cells {
            let e = cells.entry(k).or_insert(Cell { n: 0.0, f: 0.0, a: 0.0, ff: 0.0, aa: 0.0, dd: 0.0 });
            e.n += c.n;
            e.f += c.f;
            e.a += c.a;
            e.ff += c.ff;
            e.aa += c.aa;
            e.dd += c.dd;
        }
        for i in 0..n {
            pev[i] += t.pev[i];
            pev2[i] += t.pev2[i];
        }
        total += t.deals;
        max_cons = max_cons.max(t.max_cons);
    }
    // per decision and class: both halves combined, and per half for cross-fitting
    let mut keys: Vec<(usize, u32, usize)> = cells.keys().map(|&(p, f, c, _)| (p, f, c)).collect();
    keys.sort();
    keys.dedup();
    let comb = |a: Option<&Cell>, b: Option<&Cell>| {
        let mut c = Cell { n: 0.0, f: 0.0, a: 0.0, ff: 0.0, aa: 0.0, dd: 0.0 };
        for x in [a, b].into_iter().flatten() {
            c.n += x.n;
            c.f += x.f;
            c.a += x.a;
            c.ff += x.ff;
            c.aa += x.aa;
            c.dd += x.dd;
        }
        c
    };
    let mut dump: Vec<Value> = Vec::new();
    let mut gain = vec![0.0; n];
    let mut gain_cross = vec![0.0; n];
    let mut zs: Vec<f64> = Vec::new();
    let mut worst: Vec<Value> = Vec::new();
    let (mut wsum, mut wdiff, mut wvar) = (0.0, 0.0, 0.0);
    for &(p, f, c) in &keys {
        let h0 = cells.get(&(p, f, c, 0));
        let h1 = cells.get(&(p, f, c, 1));
        let all = comb(h0, h1);
        let s = g.strat[&(p, f)][c];
        let (ef, ea) = (all.f / all.n, all.a / all.n);
        let w = all.n / total;
        {
            let d = ea - ef;
            let var_d = (all.dd / all.n - d * d).max(0.0) / all.n;
            dump.push(json!({"player": p, "facing": f, "class": g.classes[c], "n": all.n, "ev_fold": ef, "ev_allin": ea, "ev_diff": d, "ev_diff_se": var_d.sqrt()}));
        }
        gain[p] += w * (ef.max(ea) - (s * ea + (1.0 - s) * ef));
        // cross-fit: choose on one half, value on the other
        if let (Some(x), Some(y)) = (h0, h1) {
            for (ch, ev) in [(x, y), (y, x)] {
                let take_a = ch.a / ch.n > ch.f / ch.n;
                let (vf, va) = (ev.f / ev.n, ev.a / ev.n);
                let best = if take_a { va } else { vf };
                // each half holds half the deals: (n_half / (total/2)) * 0.5 = n_half / total
                gain_cross[p] += (ev.n / total) * (best - (s * va + (1.0 - s) * vf));
            }
        }
        // compare with the solver's EV difference for this class
        if let Some((rf, ra, rse)) = g.ev_ref.get(&(p, f)) {
            if let (Some(rf), Some(ra), Some(rse)) = (rf[c], ra[c], rse[c]) {
                if all.n >= 200.0 {
                    let d = ea - ef;
                    let var_d = (all.dd / all.n - d * d).max(0.0) / all.n;
                    let se = (var_d + rse * rse).sqrt();
                    let z = (d - (ra - rf)) / se;
                    zs.push(z);
                    wsum += w;
                    wdiff += w * (d - (ra - rf));
                    wvar += w * w * se * se;
                    if z.abs() > 4.0 {
                        worst.push(json!({"player": p, "facing": f, "class": g.classes[c], "verify_ev_diff": d, "solver_ev_diff": ra - rf, "z": z, "n": all.n}));
                    }
                }
            }
        }
    }
    let nz = zs.len() as f64;
    let mz = zs.iter().sum::<f64>() / nz;
    let sz = (zs.iter().map(|z| (z - mz).powi(2)).sum::<f64>() / (nz - 1.0)).sqrt();
    let frac3 = zs.iter().filter(|z| z.abs() > 3.0).count() as f64 / nz;
    let pe: Vec<f64> = (0..n).map(|i| pev[i] / total).collect();
    let pe_se: Vec<f64> = (0..n).map(|i| ((pev2[i] / total - pe[i] * pe[i]) / total).sqrt()).collect();
    let sol_pev: Vec<f64> = v["player_ev"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default();
    let sol_pev_se: Vec<f64> = v["player_ev_se"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect()).unwrap_or_default();
    let pev_z: Vec<f64> = (0..n.min(sol_pev.len()))
        .map(|i| (pe[i] - sol_pev[i]) / (pe_se[i].powi(2) + sol_pev_se.get(i).copied().unwrap_or(0.0).powi(2)).sqrt())
        .collect();
    let report = json!({
        "solution": Path::new(&path).file_name().unwrap().to_string_lossy(),
        "method": "plain simulation: own RNG (PCG32), own posting and side-pot code, ICM by enumerating finishing orders, naive best-of-21 evaluator; earlier actions drawn from the strategies, both actions of each player valued exactly over later players' mixed strategies",
        "deals": total,
        "seconds": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "max_conservation_error": max_cons,
        "player_ev": pe, "player_ev_se": pe_se, "solver_player_ev": sol_pev, "solver_player_ev_se": sol_pev_se, "player_ev_z": pev_z,
        "best_response_gain_plugin": gain,
        "best_response_gain_crossfit": gain_cross,
        "solver_exploitability_eval": v["exploitability"]["eval_per_seat"],
        "ev_diff_comparison": {
            "cells_compared": nz, "z_mean": mz, "z_sd": sz, "frac_abs_z_gt_3": frac3,
            "weighted_mean_difference": wdiff / wsum,
            "weighted_mean_difference_se": wvar.sqrt() / wsum,
            "weight": "share of hands reaching the cell",
            "cells_abs_z_gt_4": worst,
        }
    });
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap() + "\n").map_err(|e| e.to_string())?;
    if let Some(dp) = get("--dump-cells") {
        std::fs::write(&dp, serde_json::to_string(&dump).unwrap() + "\n").map_err(|e| e.to_string())?;
    }
    eprintln!("{}", serde_json::to_string_pretty(&report["ev_diff_comparison"]).unwrap());
    eprintln!("player EV verify {:?}\n           solver {:?}", report["player_ev"], report["solver_player_ev"]);
    eprintln!("BR gain plug-in {:?}\nBR gain cross-fit {:?}", report["best_response_gain_plugin"], report["best_response_gain_crossfit"]);
    Ok(())
}
