// Replays solution steps into a table model (seats, bets, pot, board, log).
import { SEATS, shortLabel } from './poker.js';
import { fmtBb } from './ui.js';

const r2 = (x) => Math.round(x * 100) / 100;

export function initialModel(puzzle) {
  const seats = {};
  for (const s of SEATS) seats[s] = { seat: s, stack: 100, bet: 0, folded: false, last: null, lastKind: null };
  seats.SB.stack = 99.5; seats.SB.bet = 0.5;
  seats.BB.stack = 99; seats.BB.bet = 1;
  return {
    puzzle, seats, pot: 1.5, board: [], street: 'preflop',
    heroSeat: puzzle.hero.seat, villainSeat: puzzle.villain.seat,
    log: [], acting: null, end: null, decision: null, stepCount: 0,
  };
}

function applyState(m, st) {
  if (!st) return;
  m.pot = st.pot;
  const hs = m.seats[m.heroSeat], vs = m.seats[m.villainSeat];
  hs.stack = st.heroStack; hs.bet = st.heroBet;
  vs.stack = st.villainStack; vs.bet = st.villainBet;
}

function actionText(kind, seatObj, before, amount) {
  switch (kind) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return `Call ${fmtBb(r2(seatObj.bet - before) || amount || 0)}`;
    case 'bet': return `Bet ${fmtBb(seatObj.bet || amount)}`;
    case 'raise': return `Raise to ${fmtBb(seatObj.bet || amount)}`;
    case 'allin': return `All-in ${fmtBb(seatObj.bet || amount)}`;
    default: return kind;
  }
}

/**
 * Apply one step. `answered(index)` tells whether a decision has been answered
 * on this play (then the main line is applied and logged).
 * Returns the mutated model.
 */
export function applyStep(m, step, i, { reveals = {} } = {}) {
  m.acting = null;
  m.decision = null;
  m.stepCount = i + 1;
  switch (step.type) {
    case 'action': {
      const s = m.seats[step.seat];
      const before = s.bet;
      if (step.kind === 'fold') s.folded = true;
      if (step.state) applyState(m, step.state);
      else if (step.kind === 'raise' || step.kind === 'bet') { // third-party seat without state
        const add = (step.amount || 0) - s.bet; s.bet = step.amount || s.bet; s.stack = r2(s.stack - add);
      }
      s.last = actionText(step.kind, s, before, step.amount);
      s.lastKind = step.kind;
      m.acting = step.seat;
      m.log.push({ i, street: step.street, seat: step.seat, text: s.last, kind: step.kind, hero: step.seat === m.heroSeat, forced: step.street !== 'preflop' });
      break;
    }
    case 'deal': {
      m.street = step.street;
      m.board = m.board.concat(step.cards);
      for (const s of Object.values(m.seats)) { s.bet = 0; s.last = null; s.lastKind = null; }
      applyState(m, step.state);
      m.log.push({ i, street: step.street, deal: true, cards: step.cards });
      break;
    }
    case 'villain': {
      const s = m.seats[step.seat];
      applyState(m, step.state);
      s.last = shortLabel(step.action);
      s.lastKind = step.action.kind;
      if (step.action.kind === 'fold') s.folded = true;
      m.acting = step.seat;
      m.log.push({ i, street: step.street, seat: step.seat, text: s.last, kind: step.action.kind, villain: true, revealed: 'range' in step, step });
      break;
    }
    case 'decision': {
      const s = m.seats[m.heroSeat];
      const answered = 'mainLine' in step;
      if (!answered) {
        applyState(m, step.state);
        m.decision = step;
        m.acting = m.heroSeat;
        break;
      }
      const main = step.options.find((o) => o.id === step.mainLine);
      applyState(m, step.stateAfter);
      if (main.kind === 'fold') s.folded = true;
      s.last = shortLabel(main); s.lastKind = main.kind;
      m.acting = m.heroSeat;
      const rv = reveals[step.index];
      m.log.push({ i, street: step.street, seat: m.heroSeat, text: s.last, kind: main.kind, hero: true, decisionIndex: step.index, chose: rv && rv.choice !== step.mainLine ? rv.choiceLabel : null, grade: rv?.grade });
      break;
    }
    case 'end': {
      for (const s of Object.values(m.seats)) { s.bet = 0; }
      m.end = step;
      m.pot = step.state?.pot ?? m.pot;
      break;
    }
    default: break;
  }
  return m;
}

export function modelAt(puzzle, steps, n, opts) {
  const m = initialModel(puzzle);
  for (let i = 0; i < n && i < steps.length; i++) applyStep(m, steps[i], i, opts);
  return m;
}
