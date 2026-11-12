//! Human-readable summary of one solution JSON.

use serde_json::Value;
use std::fmt::Write;

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn s(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

fn money(x: f64) -> String {
    let t = format!("{x:.2}");
    t.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn state_line(st: &Value) -> String {
    format!(
        "pot {}, hero {} behind, villain {} behind",
        money(f(&st["pot"])), money(f(&st["heroStack"])), money(f(&st["villainStack"]))
    )
}

pub fn summarize(j: &Value) -> String {
    let mut o = String::new();
    let tags: Vec<String> = j["tags"].as_array().map(|a| a.iter().map(s).collect()).unwrap_or_default();
    let _ = writeln!(o, "{} - {}  [{}]", s(&j["id"]), s(&j["title"]), tags.join(", "));
    let sc = &j["scenario"];
    let _ = writeln!(o, "Scenario: {} ({}, tree {})", s(&sc["name"]), s(&sc["potType"]), s(&sc["tree"]));
    let h = &j["hero"];
    let hand: Vec<String> = h["hand"].as_array().unwrap().iter().map(s).collect();
    let _ = writeln!(
        o,
        "Hero: {} ({}) {} [{}]   Villain: {} ({})",
        s(&h["seat"]), s(&h["position"]), hand.join(""), s(&h["handClass"]), s(&j["villain"]["seat"]), s(&j["villain"]["position"])
    );
    let b = &j["board"];
    let flop: Vec<String> = b["flop"].as_array().unwrap().iter().map(s).collect();
    let _ = writeln!(o, "Board: {} | {} | {}", flop.join(" "), s(&b["turn"]), s(&b["river"]));
    let sv = &j["solver"];
    let _ = writeln!(
        o,
        "Solver: {} iterations, exploitability {:.2}% pot, {} MB{}, {} s",
        sv["iterations"], f(&sv["exploitabilityPctPot"]), sv["memoryMb"],
        if sv["compressed"].as_bool() == Some(true) { " (16-bit compressed)" } else { "" }, sv["seconds"]
    );

    let mut pre_actions: Vec<String> = Vec::new();
    let flush = |o: &mut String, pre: &mut Vec<String>| {
        if !pre.is_empty() {
            let _ = writeln!(o, "  {}", pre.join(", "));
            pre.clear();
        }
    };
    for st in j["steps"].as_array().unwrap() {
        match st["type"].as_str().unwrap_or("") {
            "action" => {
                let mut t = format!("{} {}", s(&st["seat"]), s(&st["kind"]));
                if let Some(a) = st.get("amount") {
                    t.push_str(&format!(" {}", money(f(a))));
                }
                if st["street"] != "preflop" {
                    t.push_str(" (forced)");
                }
                pre_actions.push(t);
            }
            "deal" => {
                flush(&mut o, &mut pre_actions);
                let cards: Vec<String> = st["cards"].as_array().unwrap().iter().map(s).collect();
                let _ = writeln!(o, "{}: {}   ({})", s(&st["street"]).to_uppercase(), cards.join(" "), state_line(&st["state"]));
            }
            "villain" => {
                flush(&mut o, &mut pre_actions);
                let opts = st["options"].as_array().unwrap();
                let freqs = st["range"]["freq"].as_array().unwrap();
                let alts: Vec<String> = opts
                    .iter()
                    .zip(freqs)
                    .filter(|(op, _)| op["id"] != st["action"]["id"])
                    .map(|(op, fq)| format!("{} {:.0}%", s(&op["label"]), 100.0 * f(fq)))
                    .collect();
                let _ = writeln!(
                    o,
                    "  Villain {}: {} ({:.0}% of range; else {})  [range {:.1} combos]",
                    s(&st["seat"]), s(&st["action"]["label"]), 100.0 * f(&st["freq"]), alts.join(", "), f(&st["range"]["combos"])
                );
            }
            "decision" => {
                flush(&mut o, &mut pre_actions);
                let src = s(&st["source"]);
                let _ = writeln!(
                    o,
                    "  HERO DECISION #{} ({}, {}{}) - {}, to call {}",
                    st["index"], s(&st["street"]), src,
                    st.get("chart").map(|c| format!(" {}", s(c))).unwrap_or_default(),
                    state_line(&st["state"]), money(f(&st["toCall"]))
                );
                let opts = st["options"].as_array().unwrap();
                let hf = st["hand"]["freq"].as_array().unwrap();
                let ev = st["hand"]["ev"].as_array();
                let rf = st["range"]["freq"].as_array().unwrap();
                for (k, op) in opts.iter().enumerate() {
                    let mark = if op["id"] == st["mainLine"] { "  <- main line" } else { "" };
                    let evs = ev.map(|e| format!("  EV {:>7.2}", f(&e[k]))).unwrap_or_default();
                    let _ = writeln!(
                        o,
                        "      {:<22} hand {:>5.1}%{}   (range {:>5.1}%){}",
                        s(&op["label"]), 100.0 * f(&hf[k]), evs, 100.0 * f(&rf[k]), mark
                    );
                }
                if let Some(e) = ev {
                    let mut v: Vec<f64> = e.iter().map(f).collect();
                    v.sort_by(|a, b| b.partial_cmp(a).unwrap());
                    let gap = if v.len() > 1 { v[0] - v[1] } else { 0.0 };
                    let pot = f(&st["state"]["pot"]);
                    let _ = writeln!(
                        o,
                        "      best-second EV gap {:.2} bb ({:.1}% pot); hand equity {:.1}%; range equity {:.1}% vs villain {:.1}%; combos hero {:.1} / villain {:.1}",
                        gap, 100.0 * gap / pot, 100.0 * f(&st["hand"]["equity"]), 100.0 * f(&st["range"]["equity"]),
                        100.0 * f(&st["villainRange"]["equity"]), f(&st["range"]["combos"]), f(&st["villainRange"]["combos"])
                    );
                }
            }
            "end" => {
                flush(&mut o, &mut pre_actions);
                let reason = s(&st["reason"]);
                let mut t = format!("END: {reason}, {}", state_line(&st["state"]));
                if reason == "showdown" {
                    let sd = &st["showdown"];
                    let vh: Vec<String> = sd["villainHand"].as_array().unwrap().iter().map(s).collect();
                    t.push_str(&format!(
                        "; villain shows {} ({}) vs hero {} -> {}",
                        vh.join(""), s(&sd["villainHandName"]), s(&sd["heroHandName"]), s(&sd["winner"])
                    ));
                }
                t.push_str(&format!("; hero net {:+.2} bb", f(&st["heroNet"])));
                let _ = writeln!(o, "{t}");
            }
            _ => {}
        }
    }
    flush(&mut o, &mut pre_actions);
    let w = j["warnings"].as_array().cloned().unwrap_or_default();
    if w.is_empty() {
        let _ = writeln!(o, "Warnings: none");
    } else {
        let _ = writeln!(o, "Warnings:");
        for x in w {
            let _ = writeln!(o, "  - {}", s(&x));
        }
    }
    o
}
