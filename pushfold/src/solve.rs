//! Solving a spot: exact heads-up, or Monte Carlo CFR+ on a fixed sample of
//! complete deals followed by an independent evaluation sample.

use crate::cards::{class_size, NUM_COMBOS};
use crate::game::{AccuracySpec, Spec, Table};
use crate::hu;
use crate::mc::{Acc, Mc, NC};
use crate::solution::{DecisionResult, Solution};
use serde_json::json;
use std::time::Instant;

/// Default exploitability target: 0.002 bb per hand for chip EV; for points the
/// same 0.002 bb converted at the value of a big blind between first and last
/// place, (P1 - PN) / total bb on the table.
pub fn default_target(table: &Table) -> f64 {
    match &table.payouts {
        None => 0.002,
        Some(p) => 0.002 * (p[0] - p[table.n - 1]) / table.total_chips(),
    }
}

pub fn target_for(spec: &Spec, table: &Table) -> f64 {
    spec.accuracy.target_exploitability.unwrap_or_else(|| default_target(table))
}

pub fn solve(spec: &Spec, verbose: bool) -> Result<(Table, Solution, f64), String> {
    let table = Table::from_spec(spec)?;
    let target = target_for(spec, &table);
    let method = spec.accuracy.method.as_str();
    let exact = match method {
        "auto" => table.n == 2,
        "exact" => {
            if table.n != 2 {
                return Err("exact method is only available heads-up".into());
            }
            true
        }
        "mc" => false,
        m => return Err(format!("unknown method {m}")),
    };
    let sol = if exact {
        // the exact engine converges far below the target; aim at 1e-6
        hu::solve_hu(&table, target.min(1e-6), spec.accuracy.max_iterations.max(20_000))
    } else {
        solve_mc(&table, &spec.accuracy, target, verbose)
    };
    Ok((table, sol, target))
}

fn cfr_update(cf: &[f64], cur: &mut [f64], reg: &mut [f64], avg_num: &mut [f64], w: f64) {
    for k in 0..cur.len() {
        let (f, a) = (cf[k * 3], cf[k * 3 + 1]);
        let s = cur[k];
        avg_num[k] += w * s;
        let v = s * a + (1.0 - s) * f;
        let r0 = (reg[2 * k] + f - v).max(0.0);
        let r1 = (reg[2 * k + 1] + a - v).max(0.0);
        reg[2 * k] = r0;
        reg[2 * k + 1] = r1;
        let sum = r0 + r1;
        cur[k] = if sum > 0.0 { r1 / sum } else { 0.5 };
    }
}

/// Best-response gain per player from counterfactual sums (unnormalised).
fn gains(mc: &Mc, cf: &[f64], strat: &[f64], choose: Option<&[f64]>) -> Vec<f64> {
    let mut g = vec![0.0; mc.n];
    for (i, info) in mc.tree.infosets.iter().enumerate() {
        for h in 0..NC {
            let k = i * NC + h;
            let (f, a) = (cf[k * 3], cf[k * 3 + 1]);
            let s = strat[k];
            let v = s * a + (1.0 - s) * f;
            let best = match choose {
                None => f.max(a),
                Some(c) => {
                    if c[k * 3 + 1] > c[k * 3] {
                        a
                    } else {
                        f
                    }
                }
            };
            g[info.player] += best - v;
        }
    }
    g
}

pub fn solve_mc(table: &Table, acc: &AccuracySpec, target: f64, verbose: bool) -> Solution {
    let t0 = Instant::now();
    let mc = Mc::new(table);
    let (ni, n) = (mc.ni, mc.n);
    let nd = acc.solve_deals as u64;
    let seed = acc.seed;
    let norm = nd as f64 * mc.c_free as f64;
    let mut cur = vec![0.5; ni * NC];
    let mut reg = vec![0.0; ni * NC * 2];
    let mut avg_num = vec![0.0; ni * NC];
    let mut avg_den = 0.0;
    let mut avg = cur.clone();
    let mut exploit = vec![f64::INFINITY; n];
    let mut it = 0usize;
    let check_every = 10;
    let mut history = Vec::new();
    // Phase 1: CFR+ on a fixed sample until its exploitability reaches the target.
    while it < acc.max_iterations {
        it += 1;
        let a = mc.pass(seed, 0, nd, &cur);
        let w = it as f64;
        cfr_update(&a.cf, &mut cur, &mut reg, &mut avg_num, w);
        avg_den += w;
        if it % check_every == 0 || it == acc.max_iterations {
            for k in 0..avg.len() {
                avg[k] = avg_num[k] / avg_den;
            }
            let a2 = mc.pass(seed, 0, nd, &avg);
            exploit = gains(&mc, &a2.cf, &avg, None).iter().map(|x| x / norm).collect();
            let mx = exploit.iter().cloned().fold(0.0, f64::max);
            history.push(json!([it, (mx * 1e6).round() / 1e6]));
            if verbose {
                eprintln!("  iter {it:5}  exploitability (solving sample) max {mx:.6}  {:.0}s", t0.elapsed().as_secs_f64());
            }
            if mx <= target {
                break;
            }
        }
    }
    for k in 0..avg.len() {
        avg[k] = avg_num[k] / avg_den;
    }
    let phase1 = it;
    // Phase 2: keep iterating with a fresh sample every iteration and average
    // these iterations only. The fixed sample's noise is averaged out, so the
    // strategy approaches the equilibrium of the real game, not of the sample.
    if acc.refine_iterations > 0 {
        let rseed = seed ^ 0x0F2E_5B1D_9C3A_7E11;
        let kd = acc.refine_deals.max(1) as u64;
        let mut num = vec![0.0; ni * NC];
        let mut den = 0.0;
        for t in 0..acc.refine_iterations {
            it += 1;
            let a = mc.pass(rseed, t as u64 * kd, kd, &cur);
            let w = (t + 1) as f64;
            cfr_update(&a.cf, &mut cur, &mut reg, &mut num, w);
            den += w;
            if verbose && (t + 1) % 25 == 0 {
                eprintln!("  refine {:4}/{}  {:.0}s", t + 1, acc.refine_iterations, t0.elapsed().as_secs_f64());
            }
        }
        for k in 0..avg.len() {
            avg[k] = num[k] / den;
        }
        // exploitability of the final strategy on the fixed solving sample (for reference)
        let a2 = mc.pass(seed, 0, nd, &avg);
        exploit = gains(&mc, &a2.cf, &avg, None).iter().map(|x| x / norm).collect();
    }
    let solve_secs = t0.elapsed().as_secs_f64();
    let mut sol = evaluate_mc(&mc, &avg, acc, it, t0);
    sol.exploit_in_sample = exploit;
    sol.extra.insert("solve_deals".into(), json!(nd));
    sol.extra.insert("phase1_iterations".into(), json!(phase1));
    sol.extra.insert("refine_iterations".into(), json!(acc.refine_iterations));
    sol.extra.insert("refine_deals_per_iteration".into(), json!(acc.refine_deals));
    sol.extra.insert("solve_seconds".into(), json!((solve_secs * 100.0).round() / 100.0));
    sol.extra.insert("convergence".into(), json!(history));
    sol
}

/// Strategy (all-in probability per infoset and class) from a solution JSON,
/// matched by decision id.
pub fn strategy_from_json(mc: &Mc, v: &serde_json::Value) -> Result<Vec<f64>, String> {
    let seats = &mc.t.seats;
    let mut strat = vec![f64::NAN; mc.ni * NC];
    let decs = v["decisions"].as_array().ok_or("no decisions")?;
    for (i, info) in mc.tree.infosets.iter().enumerate() {
        let id = crate::solution::decision_id(seats, info);
        let d = decs.iter().find(|d| d["id"] == id.as_str()).ok_or(format!("decision {id} missing"))?;
        let f = d["freq"].as_array().ok_or("freq")?;
        for h in 0..NC {
            strat[i * NC + h] = f[h].as_f64().ok_or("freq value")?;
        }
    }
    Ok(strat)
}

/// Value a fixed strategy on the evaluation sample: per decision and class the
/// EV of both actions with standard errors, exploitability, player EVs.
pub fn evaluate_mc(mc: &Mc, avg: &[f64], acc: &AccuracySpec, it: usize, t0: Instant) -> Solution {
    let (ni, n) = (mc.ni, mc.n);
    let table = mc.t;
    let seed = acc.seed;
    // Independent evaluation sample.
    let eval_seed = seed ^ 0x5EED_E7A1_0000_0001;
    let batches = 32u64;
    let nd2 = (acc.eval_deals as u64).div_ceil(batches) * batches;
    let per = nd2 / batches;
    let parts: Vec<Acc> = (0..batches).map(|b| mc.pass(eval_seed, b * per, per, &avg)).collect();
    let mut tot = Acc::new(ni, n);
    for p in &parts {
        tot.add(p);
    }
    let bf = batches as f64;
    let infl = bf / (bf - 1.0);
    let cfree = mc.c_free as f64;
    let mut decisions = Vec::new();
    let mut max_se = 0.0f64;
    for (i, info) in mc.tree.infosets.iter().enumerate() {
        let mut d = DecisionResult::new(info.clone());
        let mut xs = 0.0;
        for h in 0..NC {
            let k = (i * NC + h) * 3;
            let (yf, ya, x) = (tot.cf[k], tot.cf[k + 1], tot.cf[k + 2]);
            xs += x;
            d.freq[h] = avg[i * NC + h];
            let csz = class_size(h) as f64;
            d.class_reach[h] = x / (nd2 as f64 * csz * cfree / NUM_COMBOS as f64);
            d.samples[h] = x * NUM_COMBOS as f64 / (csz * cfree);
            if x <= 0.0 {
                d.ev_fold[h] = f64::NAN;
                d.ev_allin[h] = f64::NAN;
                d.ev_se[h] = f64::NAN;
                continue;
            }
            let (rf, ra) = (yf / x, ya / x);
            let rd = ra - rf;
            let (mut zf, mut za, mut zd) = (0.0, 0.0, 0.0);
            for p in &parts {
                let (pf, pa, px) = (p.cf[k], p.cf[k + 1], p.cf[k + 2]);
                zf += (pf - rf * px).powi(2);
                za += (pa - ra * px).powi(2);
                zd += ((pa - pf) - rd * px).powi(2);
            }
            d.ev_fold[h] = rf;
            d.ev_allin[h] = ra;
            d.ev_fold_se[h] = (infl * zf).sqrt() / x;
            d.ev_allin_se[h] = (infl * za).sqrt() / x;
            d.ev_se[h] = (infl * zd).sqrt() / x;
        }
        d.reach = xs / (nd2 as f64 * cfree);
        if d.reach >= 0.01 {
            // largest SE among classes that reach the decision reasonably often
            for h in 0..NC {
                if d.class_reach[h] >= 0.01 && d.ev_se[h].is_finite() {
                    max_se = max_se.max(d.ev_se[h]);
                }
            }
        }
        decisions.push(d);
    }
    // exploitability on the evaluation sample
    let per_norm = per as f64 * cfree;
    let plug = gains(&mc, &tot.cf, &avg, None).iter().map(|x| x / (nd2 as f64 * cfree)).collect::<Vec<_>>();
    // SE: the per-batch gains with the best response fixed from the totals
    let mut batch_g: Vec<Vec<f64>> = Vec::new();
    for p in &parts {
        batch_g.push(gains(&mc, &p.cf, &avg, Some(&tot.cf)).iter().map(|x| x / per_norm).collect());
    }
    let mut plug_se = vec![0.0; n];
    for j in 0..n {
        let m: f64 = batch_g.iter().map(|g| g[j]).sum::<f64>() / bf;
        let var: f64 = batch_g.iter().map(|g| (g[j] - m).powi(2)).sum::<f64>() / (bf - 1.0);
        plug_se[j] = (var / bf).sqrt();
    }
    // cross-fit: best response chosen on one half, valued on the other
    let mut h1 = Acc::new(ni, n);
    let mut h2 = Acc::new(ni, n);
    for (b, p) in parts.iter().enumerate() {
        if b % 2 == 0 {
            h1.add(p)
        } else {
            h2.add(p)
        }
    }
    let half = nd2 as f64 / 2.0 * cfree;
    let g12 = gains(&mc, &h2.cf, &avg, Some(&h1.cf));
    let g21 = gains(&mc, &h1.cf, &avg, Some(&h2.cf));
    let cross: Vec<f64> = (0..n).map(|j| 0.5 * (g12[j] + g21[j]) / half).collect();
    // player EVs
    let mut pev = vec![0.0; n];
    let mut pev_se = vec![0.0; n];
    for j in 0..n {
        pev[j] = tot.pev[j] / nd2 as f64;
        let m = pev[j];
        let var: f64 = parts.iter().map(|p| (p.pev[j] / per as f64 - m).powi(2)).sum::<f64>() / (bf - 1.0);
        pev_se[j] = (var / bf).sqrt();
    }

    let mut sol = Solution::new(table, "monte-carlo-cfr+", it, t0.elapsed().as_secs_f64());
    sol.decisions = decisions;
    sol.exploit_in_sample = vec![f64::NAN; n];
    sol.exploit_eval = plug;
    sol.exploit_eval_se = plug_se;
    sol.exploit_eval_crossfit = cross;
    sol.player_ev = pev;
    sol.player_ev_se = pev_se;
    sol.equity_method = "Monte Carlo over complete deals (board and all hole cards from one deck), every possible hero hand enumerated per deal; all card removal (blockers, folded hands, board) and multi-way side pots exact per deal; error = sampling error, reported as standard errors".into();
    sol.equity_error = max_se;
    sol.extra.insert("eval_deals".into(), json!(nd2));
    sol.extra.insert("seed".into(), json!(seed));
    sol.extra.insert("hero_hands_per_deal".into(), json!(mc.c_free));
    sol.extra.insert("se_batches".into(), json!(batches));
    sol.extra.insert("max_conservation_error".into(), json!(tot.max_conservation_error));
    sol
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{AnteSpec, BlindSpec, PayoffSpec};

    /// The Monte Carlo engine, valuing the exact heads-up equilibrium of an ICM
    /// spot with unequal stacks and antes, must reproduce the exact engine's
    /// EVs within its own standard errors.
    #[test]
    fn mc_engine_agrees_with_exact_heads_up() {
        let mut acc = AccuracySpec::default();
        acc.eval_deals = 320_000;
        acc.seed = 99;
        let spec = Spec {
            name: None,
            note: None,
            players: 2,
            stacks: vec![7.0, 13.0],
            ante: AnteSpec::PerPlayer { amount: 0.1 },
            blinds: BlindSpec::default(),
            payoff: PayoffSpec::Points { payouts: None },
            accuracy: acc.clone(),
        };
        let table = Table::from_spec(&spec).unwrap();
        let exact = hu::solve_hu(&table, 1e-8, 100_000);
        let mc = Mc::new(&table);
        let mut strat = Vec::new();
        for d in &exact.decisions {
            strat.extend_from_slice(&d.freq);
        }
        let sol = evaluate_mc(&mc, &strat, &acc, 0, Instant::now());
        let (mut n, mut s2, mut zmax) = (0.0, 0.0, 0.0f64);
        for (de, dm) in exact.decisions.iter().zip(sol.decisions.iter()) {
            assert_eq!(de.info.player, dm.info.player);
            for h in 0..NC {
                if !(dm.ev_se[h] > 0.0) || !de.ev_allin[h].is_finite() {
                    continue;
                }
                let z = ((dm.ev_allin[h] - dm.ev_fold[h]) - (de.ev_allin[h] - de.ev_fold[h])) / dm.ev_se[h];
                n += 1.0;
                s2 += z * z;
                zmax = zmax.max(z.abs());
            }
        }
        let rms = (s2 / n).sqrt();
        assert!(n > 300.0);
        assert!(rms < 1.5 && zmax < 5.0, "rms z {rms}, max |z| {zmax}");
        for j in 0..2 {
            let z = (sol.player_ev[j] - exact.player_ev[j]) / sol.player_ev_se[j];
            assert!(z.abs() < 4.0, "player {j}: z {z}");
        }
        // points are conserved: the two players' EVs sum to 15 + 8
        assert!((exact.player_ev[0] + exact.player_ev[1] - 23.0).abs() < 1e-9);
    }
}
