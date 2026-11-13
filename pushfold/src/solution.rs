//! Solver output: per decision point the 169-class strategy and action EVs,
//! plus exploitability and accuracy figures, written as JSON.

use crate::cards::{class_name, class_size, NUM_CLASSES};
use crate::game::{InfoSet, Spec, Table};
use serde_json::{json, Map, Value};

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug)]
pub struct DecisionResult {
    pub info: InfoSet,
    /// probability of going all-in (jam or call), per class
    pub freq: Vec<f64>,
    /// EV of folding / going all-in, conditional on reaching this decision with the class
    pub ev_fold: Vec<f64>,
    pub ev_allin: Vec<f64>,
    /// standard error of (ev_allin - ev_fold) from Monte Carlo sampling (0 = exact)
    pub ev_se: Vec<f64>,
    pub ev_fold_se: Vec<f64>,
    pub ev_allin_se: Vec<f64>,
    /// P(this decision is reached | the player holds the class)
    pub class_reach: Vec<f64>,
    /// Monte Carlo: number of (deal, hole cards) samples behind the class's EVs, reach-weighted
    pub samples: Vec<f64>,
    /// P(this decision is reached) per hand
    pub reach: f64,
}

impl DecisionResult {
    pub fn new(info: InfoSet) -> Self {
        DecisionResult {
            info,
            freq: vec![0.0; NUM_CLASSES],
            ev_fold: vec![0.0; NUM_CLASSES],
            ev_allin: vec![0.0; NUM_CLASSES],
            ev_se: vec![0.0; NUM_CLASSES],
            ev_fold_se: vec![0.0; NUM_CLASSES],
            ev_allin_se: vec![0.0; NUM_CLASSES],
            class_reach: vec![0.0; NUM_CLASSES],
            samples: vec![0.0; NUM_CLASSES],
            reach: 0.0,
        }
    }

    /// Share of all hands (combo-weighted, adjusted for card removal through
    /// the class reach) that go all-in when this decision is reached.
    pub fn range_pct(&self) -> f64 {
        let (mut num, mut den) = (0.0, 0.0);
        for h in 0..NUM_CLASSES {
            let w = class_size(h) as f64 * self.class_reach[h];
            num += w * self.freq[h];
            den += w;
        }
        if den > 0.0 {
            100.0 * num / den
        } else {
            0.0
        }
    }
}

#[derive(Clone, Debug)]
pub struct Solution {
    pub seats: Vec<&'static str>,
    pub method: String,
    pub iterations: usize,
    pub seconds: f64,
    pub decisions: Vec<DecisionResult>,
    /// per player: best-response gain per hand in the game that was solved
    /// (exact for heads-up; the solving sample for Monte Carlo)
    pub exploit_in_sample: Vec<f64>,
    /// per player: best-response gain per hand estimated on the independent
    /// evaluation sample (plug-in: best response chosen and valued on it)
    pub exploit_eval: Vec<f64>,
    pub exploit_eval_se: Vec<f64>,
    /// per player: cross-fitted estimate (best response chosen on one half of
    /// the evaluation sample, valued on the other half)
    pub exploit_eval_crossfit: Vec<f64>,
    pub player_ev: Vec<f64>,
    pub player_ev_se: Vec<f64>,
    pub equity_method: String,
    /// largest standard error of an EV difference at a decision reached in at
    /// least 1% of hands (0 for exact)
    pub equity_error: f64,
    pub extra: Map<String, Value>,
    pub units: &'static str,
}

impl Solution {
    pub fn new(table: &Table, method: &str, iterations: usize, seconds: f64) -> Self {
        Solution {
            seats: table.seats.clone(),
            method: method.into(),
            iterations,
            seconds,
            decisions: Vec::new(),
            exploit_in_sample: vec![],
            exploit_eval: vec![],
            exploit_eval_se: vec![],
            exploit_eval_crossfit: vec![],
            player_ev: vec![],
            player_ev_se: vec![],
            equity_method: String::new(),
            equity_error: 0.0,
            extra: Map::new(),
            units: table.payoff_units(),
        }
    }
}

fn r(x: f64, digits: i32) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    let p = 10f64.powi(digits);
    json!((x * p).round() / p)
}

fn arr(v: &[f64], digits: i32) -> Value {
    Value::Array(v.iter().map(|&x| r(x, digits)).collect())
}

pub fn decision_id(seats: &[&str], info: &InfoSet) -> String {
    let me = seats[info.player];
    if info.facing == 0 {
        return format!("{me}_open");
    }
    let facing: Vec<&str> = (0..seats.len()).filter(|&j| info.facing & (1 << j) != 0).map(|j| seats[j]).collect();
    format!("{me}_vs_{}", facing.join("_"))
}

pub fn to_json(spec: &Spec, table: &Table, sol: &Solution, target: f64) -> Value {
    let seats = &sol.seats;
    let mut decisions = Vec::new();
    for d in &sol.decisions {
        let facing: Vec<&str> = (0..seats.len()).filter(|&j| d.info.facing & (1 << j) != 0).map(|j| seats[j]).collect();
        let action = if d.info.facing == 0 { "jam" } else { "call" };
        let diff: Vec<f64> = (0..NUM_CLASSES).map(|h| d.ev_allin[h] - d.ev_fold[h]).collect();
        let mut o = Map::new();
        o.insert("id".into(), json!(decision_id(seats, &d.info)));
        o.insert("seat".into(), json!(seats[d.info.player]));
        o.insert("position".into(), json!(d.info.player));
        o.insert("facing".into(), json!(facing));
        o.insert("allin_action".into(), json!(action));
        o.insert("reach".into(), r(d.reach, 6));
        o.insert("allin_pct".into(), r(d.range_pct(), 2));
        o.insert("freq".into(), arr(&d.freq, 3));
        o.insert("ev_fold".into(), arr(&d.ev_fold, 4));
        o.insert("ev_allin".into(), arr(&d.ev_allin, 4));
        o.insert("ev_diff".into(), arr(&diff, 4));
        o.insert("ev_diff_se".into(), arr(&d.ev_se, 4));
        o.insert("class_reach".into(), arr(&d.class_reach, 5));
        o.insert("samples".into(), arr(&d.samples, 0));
        decisions.push(Value::Object(o));
    }
    let max_of = |v: &[f64]| v.iter().cloned().fold(0.0, f64::max);
    let mut expl = Map::new();
    expl.insert("units".into(), json!(format!("{} per hand", sol.units)));
    expl.insert("target".into(), r(target, 6));
    expl.insert("solved_game_per_seat".into(), arr(&sol.exploit_in_sample, 6));
    expl.insert("solved_game_max".into(), r(max_of(&sol.exploit_in_sample), 6));
    expl.insert("eval_per_seat".into(), arr(&sol.exploit_eval, 6));
    expl.insert("eval_se_per_seat".into(), arr(&sol.exploit_eval_se, 6));
    expl.insert("eval_max".into(), r(max_of(&sol.exploit_eval), 6));
    expl.insert("eval_crossfit_per_seat".into(), arr(&sol.exploit_eval_crossfit, 6));
    expl.insert("eval_crossfit_max".into(), r(max_of(&sol.exploit_eval_crossfit), 6));
    let mut acc = Map::new();
    acc.insert("method".into(), json!(sol.method));
    acc.insert("equity_method".into(), json!(sol.equity_method));
    acc.insert("max_ev_diff_se".into(), r(sol.equity_error, 5));
    for (k, v) in &sol.extra {
        acc.insert(k.clone(), v.clone());
    }
    let names: Vec<String> = (0..NUM_CLASSES).map(class_name).collect();
    json!({
        "engine": {"name": "pushfold", "version": ENGINE_VERSION},
        "spec": spec,
        "seats": seats,
        "stacks": table.stacks,
        "posted": {"live": table.live_posted, "dead": table.dead_posted, "allin_by_posting": table.forced},
        "units": sol.units,
        "ev_definition": if sol.units == "bb" {
            "expected change of the player's stack over the hand, in big blinds, measured from his stack before posting"
        } else {
            "expected league points after the hand (Malmuth-Harville on the stacks after the hand)"
        },
        "class_order": "13x13 grid, index 13*i+j with R='AKQJT98765432': i==j pair R[i]R[i], i<j suited R[i]R[j]s, i>j offsuit R[j]R[i]o (same as data/ranges.json and web/js/poker.js)",
        "classes": names,
        "player_ev": arr(&sol.player_ev, 5),
        "player_ev_se": arr(&sol.player_ev_se, 5),
        "decisions": decisions,
        "exploitability": expl,
        "accuracy": acc,
        "iterations": sol.iterations,
        "seconds": r(sol.seconds, 2),
    })
}
