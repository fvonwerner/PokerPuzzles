//! Serde types for the authored inputs (SPEC section 2).

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangesFile {
    pub chips_per_bb: f64,
    #[serde(default)]
    #[allow(dead_code)]
    pub seats: Vec<String>,
    pub charts: BTreeMap<String, Chart>,
    pub trees: BTreeMap<String, Tree>,
    pub tree_defaults: TreeDefaults,
    pub scenarios: BTreeMap<String, Scenario>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Chart {
    #[serde(default)]
    #[allow(dead_code)]
    pub title: String,
    pub options: Vec<ChartOption>,
    pub ranges: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ChartOption {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Tree {
    pub flop: StreetSizes,
    pub turn: StreetSizes,
    pub river: StreetSizes,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreetSizes {
    pub oop_bet: String,
    pub oop_raise: String,
    pub ip_bet: String,
    pub ip_raise: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeDefaults {
    pub add_allin_threshold: f64,
    pub force_allin_threshold: f64,
    pub merging_threshold: f64,
    #[serde(default)]
    pub rake_rate: f64,
    #[serde(default)]
    pub rake_cap: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub name: String,
    pub pot_type: String,
    pub tree: String,
    pub ip: SeatRange,
    pub oop: SeatRange,
    pub pot_bb: f64,
    pub stack_bb: f64,
    pub preflop: Vec<PreflopEntry>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SeatRange {
    pub seat: String,
    pub chart: String,
    pub action: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PreflopEntry {
    pub seat: String,
    pub kind: String,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub chart: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Puzzle {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub scenario: String,
    pub hero: String,
    pub hand: String,
    pub flop: String,
    pub turn: String,
    pub river: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub villain: Option<Vec<String>>,
    #[serde(default)]
    pub hero_line: Option<Vec<String>>,
}
