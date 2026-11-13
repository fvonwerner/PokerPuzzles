//! pushfold: Nash equilibrium of the push/fold game for short-stacked
//! tournament spots (2 to 6 players), chip EV or league points (ICM).
//!
//! Usage:
//!   pushfold solve --spec spot.json --out out.json [--threads N] [--quiet]
//!   pushfold batch --specs DIR --out-dir DIR [--threads N] [--skip-existing]
//!   pushfold equity AhAs KdKc [QhQd ...] [--naive]
//!   pushfold hu-sweep --out FILE [--from 1] [--to 20] [--step 0.05] [--ante 0]
//!   pushfold verify --solution out.json --deals N --out report.json [--seed S] [--dump-cells F]
//!   pushfold evaluate --spec spot.json --strategy out.json --out eval.json
//!   pushfold bunching --solution out.json --out report.json
//!   pushfold reformat file.json ...
//! See docs/TOURNAMENT.md.

mod cards;
mod eval;
mod game;
mod hu;
mod icm;
mod mc;
mod solution;
mod solve;
mod validate;
mod verify;

use std::path::{Path, PathBuf};
use std::time::Instant;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn set_threads(args: &[String]) {
    let threads = arg(args, "--threads").and_then(|s| s.parse().ok()).unwrap_or(6usize);
    let _ = rayon::ThreadPoolBuilder::new().num_threads(threads).build_global();
}

fn read_spec(path: &Path) -> Result<game::Spec, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{}: {e}", path.display()))
}

/// Pretty JSON with arrays of plain values kept on one line.
fn to_json_text(v: &serde_json::Value, indent: usize, out: &mut String) {
    use serde_json::Value;
    let pad = |n: usize| " ".repeat(n);
    match v {
        Value::Object(m) if !m.is_empty() => {
            out.push_str("{\n");
            for (k, (key, val)) in m.iter().enumerate() {
                out.push_str(&pad(indent + 1));
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push_str(": ");
                to_json_text(val, indent + 1, out);
                if k + 1 < m.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(indent));
            out.push('}');
        }
        Value::Array(a) if a.iter().any(|x| x.is_object() || x.is_array()) => {
            out.push_str("[\n");
            for (k, val) in a.iter().enumerate() {
                out.push_str(&pad(indent + 1));
                to_json_text(val, indent + 1, out);
                if k + 1 < a.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad(indent));
            out.push(']');
        }
        _ => out.push_str(&serde_json::to_string(v).unwrap()),
    }
}

fn write_json(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut s = String::new();
    to_json_text(v, 0, &mut s);
    std::fs::write(path, s + "\n").map_err(|e| format!("{}: {e}", path.display()))
}

fn solve_one(spec_path: &Path, out: &Path, verbose: bool) -> Result<serde_json::Value, String> {
    let spec = read_spec(spec_path)?;
    let t0 = Instant::now();
    if verbose {
        eprintln!("solving {} ({} players, stacks {:?})", spec_path.display(), spec.players, spec.stacks);
    }
    let (table, sol, target) = solve::solve(&spec, verbose)?;
    let v = solution::to_json(&spec, &table, &sol, target);
    write_json(out, &v)?;
    let mx = |x: &[f64]| x.iter().cloned().fold(0.0, f64::max);
    eprintln!(
        "{}: {} iterations, exploitability solved {:.6} / eval {:.6} (cross-fit {:.6}) {} per hand, max EV-diff SE {:.4}, {:.1}s",
        spec_path.file_name().unwrap().to_string_lossy(),
        sol.iterations,
        mx(&sol.exploit_in_sample),
        mx(&sol.exploit_eval),
        mx(&sol.exploit_eval_crossfit),
        sol.units,
        sol.equity_error,
        t0.elapsed().as_secs_f64()
    );
    Ok(v)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let result: Result<(), String> = match cmd {
        "solve" => {
            set_threads(&args);
            eval::init();
            let spec = arg(&args, "--spec").ok_or("--spec required");
            let out = arg(&args, "--out").ok_or("--out required");
            match (spec, out) {
                (Ok(s), Ok(o)) => solve_one(Path::new(&s), Path::new(&o), !flag(&args, "--quiet")).map(|_| ()),
                (Err(e), _) | (_, Err(e)) => Err(e.into()),
            }
        }
        "batch" => {
            set_threads(&args);
            eval::init();
            (|| -> Result<(), String> {
                let dir = PathBuf::from(arg(&args, "--specs").ok_or("--specs required")?);
                let out_dir = PathBuf::from(arg(&args, "--out-dir").ok_or("--out-dir required")?);
                let mut specs: Vec<PathBuf> = std::fs::read_dir(&dir)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                    .collect();
                specs.sort();
                if let Some(only) = arg(&args, "--only") {
                    specs.retain(|p| p.file_name().unwrap().to_string_lossy().contains(&only));
                }
                let t0 = Instant::now();
                let mut summary = Vec::new();
                for p in &specs {
                    let out = out_dir.join(p.file_name().unwrap());
                    if flag(&args, "--skip-existing") && out.exists() {
                        continue;
                    }
                    let ts = Instant::now();
                    let v = match solve_one(p, &out, flag(&args, "--verbose")) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("FAILED {}: {e}", p.display());
                            continue;
                        }
                    };
                    summary.push(serde_json::json!({
                        "spot": p.file_stem().unwrap().to_string_lossy(),
                        "seconds": (ts.elapsed().as_secs_f64() * 10.0).round() / 10.0,
                        "iterations": v["iterations"],
                        "exploitability_solved_max": v["exploitability"]["solved_game_max"],
                        "exploitability_eval_max": v["exploitability"]["eval_max"],
                        "exploitability_crossfit_max": v["exploitability"]["eval_crossfit_max"],
                        "target": v["exploitability"]["target"],
                        "units": v["units"],
                        "max_ev_diff_se": v["accuracy"]["max_ev_diff_se"],
                    }));
                }
                eprintln!("batch: {} spots in {:.1}s", summary.len(), t0.elapsed().as_secs_f64());
                if let Some(s) = arg(&args, "--summary") {
                    write_json(Path::new(&s), &serde_json::Value::Array(summary))?;
                }
                Ok(())
            })()
        }
        "evaluate" => {
            // value the strategies of an existing solution on a fresh Monte Carlo sample
            set_threads(&args);
            eval::init();
            (|| -> Result<(), String> {
                let spec = read_spec(Path::new(&arg(&args, "--spec").ok_or("--spec required")?))?;
                let sv: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(arg(&args, "--strategy").ok_or("--strategy required")?).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                let out = arg(&args, "--out").ok_or("--out required")?;
                let table = game::Table::from_spec(&spec)?;
                let m = mc::Mc::new(&table);
                let strat = solve::strategy_from_json(&m, &sv)?;
                let t0 = Instant::now();
                let mut sol = solve::evaluate_mc(&m, &strat, &spec.accuracy, 0, t0);
                sol.method = "monte-carlo evaluation of a given strategy".into();
                let target = solve::target_for(&spec, &table);
                write_json(Path::new(&out), &solution::to_json(&spec, &table, &sol, target))
            })()
        }
        "reformat" => {
            // rewrite JSON files in the compact-array layout
            (|| -> Result<(), String> {
                for p in &args[2..] {
                    let v: serde_json::Value =
                        serde_json::from_str(&std::fs::read_to_string(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    write_json(Path::new(p), &v)?;
                }
                Ok(())
            })()
        }
        "equity" => {
            set_threads(&args);
            eval::init();
            validate::equity_cmd(&args[2..])
        }
        "bunching" => {
            set_threads(&args);
            eval::init();
            validate::bunching_cmd(&args)
        }
        "hu-sweep" => {
            set_threads(&args);
            eval::init();
            validate::hu_sweep_cmd(&args)
        }
        "verify" => {
            set_threads(&args);
            eval::init();
            verify::verify_cmd(&args)
        }
        _ => Err("usage: pushfold solve|batch|evaluate|verify|equity|hu-sweep|bunching|reformat ... (see docs/TOURNAMENT.md)".into()),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
