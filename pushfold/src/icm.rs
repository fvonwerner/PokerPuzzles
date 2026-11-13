//! League points by the Malmuth-Harville (ICM) model.
//!
//! After a hand, players with no chips left take the lowest open places. Several
//! players busting in the same hand are ordered by their stack before the hand
//! (bigger stack = better place); equal stacks split the points of the places
//! they share. Survivors share the remaining top places by Malmuth-Harville on
//! their final stacks.

/// Expected payout of each player for places 1..=stacks.len(), Malmuth-Harville.
/// Uses a DP over the set of players already placed. All stacks must be > 0.
pub fn malmuth_harville(stacks: &[f64], payouts: &[f64]) -> Vec<f64> {
    let m = stacks.len();
    assert!(m <= 16 && payouts.len() >= m);
    let total: f64 = stacks.iter().sum();
    let mut ev = vec![0.0; m];
    let full = 1usize << m;
    // prob[S] = probability that exactly the players in S took places 1..|S|
    let mut prob = vec![0.0f64; full];
    let mut placed_chips = vec![0.0f64; full];
    prob[0] = 1.0;
    for s in 0..full {
        let p = prob[s];
        if p == 0.0 {
            continue;
        }
        let k = (s as u32).count_ones() as usize;
        if k == m {
            continue;
        }
        let rest = total - placed_chips[s];
        for j in 0..m {
            if s & (1 << j) != 0 {
                continue;
            }
            let q = p * stacks[j] / rest;
            ev[j] += q * payouts[k];
            let t = s | (1 << j);
            prob[t] += q;
            placed_chips[t] = placed_chips[s] + stacks[j];
        }
    }
    ev
}

/// Points of every player after a hand that ended with `final_stacks`, given the
/// stacks before the hand (`initial`) and the payouts of the open places.
pub fn points_after_hand(final_stacks: &[f64], initial: &[f64], payouts: &[f64]) -> Vec<f64> {
    let n = final_stacks.len();
    assert!(payouts.len() >= n);
    let eps = 1e-9;
    let survivors: Vec<usize> = (0..n).filter(|&i| final_stacks[i] > eps).collect();
    let mut busted: Vec<usize> = (0..n).filter(|&i| final_stacks[i] <= eps).collect();
    let m = survivors.len();
    let mut out = vec![0.0; n];
    if m > 0 {
        let st: Vec<f64> = survivors.iter().map(|&i| final_stacks[i]).collect();
        let ev = malmuth_harville(&st, &payouts[..m]);
        for (k, &i) in survivors.iter().enumerate() {
            out[i] = ev[k];
        }
    }
    // Busted players: places m+1..n, better place for the bigger starting stack.
    busted.sort_by(|&a, &b| initial[b].partial_cmp(&initial[a]).unwrap());
    let mut k = 0;
    while k < busted.len() {
        let mut e = k + 1;
        while e < busted.len() && (initial[busted[e]] - initial[busted[k]]).abs() <= 1e-12 {
            e += 1;
        }
        let share: f64 = (k..e).map(|t| payouts[m + t]).sum::<f64>() / (e - k) as f64;
        for t in k..e {
            out[busted[t]] = share;
        }
        k = e;
    }
    out
}

/// League payouts for places 1st..6th.
pub const LEAGUE_POINTS: [f64; 6] = [15.0, 8.0, 5.0, 3.0, 2.0, 1.0];

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn two_players_is_linear_in_chips() {
        let ev = malmuth_harville(&[30.0, 10.0], &[15.0, 8.0]);
        assert!(close(ev[0], 8.0 + 7.0 * 0.75));
        assert!(close(ev[1], 8.0 + 7.0 * 0.25));
    }

    #[test]
    fn three_players_hand_checked() {
        // Stacks 50/30/20, payouts 15/8/5.
        // P(A 1st)=.5, P(B 1st)=.3, P(C 1st)=.2.
        // P(A 2nd)= .3*50/70 + .2*50/80 = .214285714 + .125 = .339285714
        // P(A 3rd)= 1-.5-.339285714 = .160714286
        // EV(A)= 15*.5 + 8*.339285714 + 5*.160714286 = 11.016071429
        let ev = malmuth_harville(&[50.0, 30.0, 20.0], &[15.0, 8.0, 5.0]);
        let pa2 = 0.3 * 50.0 / 70.0 + 0.2 * 50.0 / 80.0;
        let ea = 15.0 * 0.5 + 8.0 * pa2 + 5.0 * (1.0 - 0.5 - pa2);
        assert!(close(ev[0], ea));
        assert!(close(ev.iter().sum::<f64>(), 28.0));
        // B: P(1st)=.3, P(2nd)= .5*30/50 + .2*30/80 = .3 + .075 = .375
        let eb = 15.0 * 0.3 + 8.0 * 0.375 + 5.0 * (1.0 - 0.3 - 0.375);
        assert!(close(ev[1], eb));
    }

    #[test]
    fn equal_stacks_split_evenly() {
        let ev = malmuth_harville(&[10.0; 6], &LEAGUE_POINTS);
        for e in ev {
            assert!(close(e, 34.0 / 6.0));
        }
    }

    #[test]
    fn busted_players_ranked_by_starting_stack() {
        // 4 players left: payouts 15/8/5/3. Players 2 and 3 bust in the same hand;
        // player 3 started bigger so he takes 3rd (5), player 2 takes 4th (3).
        let pts = points_after_hand(&[30.0, 10.0, 0.0, 0.0], &[15.0, 10.0, 6.0, 9.0], &LEAGUE_POINTS[..4]);
        assert!(close(pts[2], 3.0));
        assert!(close(pts[3], 5.0));
        assert!(close(pts[0], 8.0 + 7.0 * 0.75));
        assert!(close(pts.iter().sum::<f64>(), 31.0));
        // Equal starting stacks split 3rd and 4th.
        let pts = points_after_hand(&[30.0, 10.0, 0.0, 0.0], &[15.0, 10.0, 7.5, 7.5], &LEAGUE_POINTS[..4]);
        assert!(close(pts[2], 4.0) && close(pts[3], 4.0));
        // Everyone but one busts: the survivor wins.
        let pts = points_after_hand(&[40.0, 0.0, 0.0], &[10.0, 20.0, 10.0], &LEAGUE_POINTS[..3]);
        assert!(close(pts[0], 15.0) && close(pts[1], 8.0) && close(pts[2], 5.0));
    }
}
