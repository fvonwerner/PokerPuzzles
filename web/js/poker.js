// Cards, action colours and hand-class helpers shared by every view.
import { h, fmtBb } from './ui.js';

export const SEATS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const RANKS = 'AKQJT98765432';
const SUIT = {
  s: { sym: '♠', name: 'spades' }, h: { sym: '♥', name: 'hearts' },
  d: { sym: '♦', name: 'diamonds' }, c: { sym: '♣', name: 'clubs' },
};
const RANK_NAME = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };

/** A playing card. size: 'sm' | 'md' | 'lg'. card = 'Ah' or null for a card back. */
export function cardEl(card, { size = 'md', key } = {}) {
  if (!card) return h(`span.card.card-back.card-${size}`, { 'aria-label': 'Face-down card', role: 'img', dataset: key ? { key } : {} });
  const r = card[0], s = card[1];
  const rank = r === 'T' ? '10' : r;
  return h(`span.card.card-${size}.suit-${s}`, {
    role: 'img', 'aria-label': `${RANK_NAME[r]} of ${SUIT[s].name}`, dataset: key ? { key } : {},
  },
  h('span.card-rank', { 'aria-hidden': 'true' }, rank),
  h('span.card-suit', { 'aria-hidden': 'true' }, SUIT[s].sym));
}

/** Inline text for a card ("A♥") coloured by suit. */
export function cardText(card) {
  return h(`span.ctext.suit-${card[1]}`, (card[0] === 'T' ? '10' : card[0]) + SUIT[card[1]].sym);
}

// ---------- action colours ----------
// fold blue, check/call green, bets and raises red, darker with size.
const AGGRO_LIGHT = [10, 64, 47];   // hsl of the smallest bet
const AGGRO_DARK = [352, 62, 31];  // hsl of the largest non-all-in bet
const ALLIN = 'hsl(340 60% 23%)';
const lerp = (a, b, t) => a + (b - a) * t;

export function actionColors(options) {
  const aggro = options.filter((o) => o.kind === 'bet' || o.kind === 'raise').sort((a, b) => (a.amount || 0) - (b.amount || 0));
  return options.map((o) => {
    if (o.kind === 'fold') return 'var(--c-fold)';
    if (o.kind === 'check' || o.kind === 'call') return 'var(--c-call)';
    if (o.kind === 'allin') return ALLIN;
    const i = aggro.indexOf(o);
    const t = aggro.length <= 1 ? 0.45 : i / (aggro.length - 1);
    let hue = lerp(AGGRO_LIGHT[0], AGGRO_DARK[0] - 360, t); if (hue < 0) hue += 360;
    return `hsl(${hue.toFixed(0)} ${lerp(AGGRO_LIGHT[1], AGGRO_DARK[1], t).toFixed(0)}% ${lerp(AGGRO_LIGHT[2], AGGRO_DARK[2], t).toFixed(0)}%)`;
  });
}

/** Short display label of an option, e.g. "Bet 1.8". */
export function shortLabel(o) {
  // Options without a size (e.g. in Learn charts) use their own label.
  if ((o.amount === undefined || o.amount === null) && o.kind !== 'fold' && o.kind !== 'check' && o.label) return o.label;
  switch (o.kind) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return `Call ${fmtBb(o.amount)}`;
    case 'bet': return `Bet ${fmtBb(o.amount)}`;
    case 'raise': return `Raise ${fmtBb(o.amount)}`;
    case 'allin': return `All-in ${fmtBb(o.amount)}`;
    default: return o.label || o.id;
  }
}

/** Size as % of the pot before the action (bets: pctPot; raises/calls: chips added / pot). */
export function pctOfPot(o, state) {
  if (o.kind === 'bet' && typeof o.pctPot === 'number') return o.pctPot;
  if (!state || !state.pot) return null;
  if (o.kind === 'call') return Math.round((100 * o.amount) / state.pot);
  if (o.kind === 'raise' || o.kind === 'allin') return Math.round((100 * (o.amount - (state.heroBet || 0))) / state.pot);
  return null;
}

// ---------- hand classes ----------
export function classIndexName(c) {
  const i = Math.floor(c / 13), j = c % 13;
  if (i === j) return RANKS[i] + RANKS[i];
  if (i < j) return RANKS[i] + RANKS[j] + 's';
  return RANKS[j] + RANKS[i] + 'o';
}
export function classIndexOf(name) {
  const a = RANKS.indexOf(name[0]), b = RANKS.indexOf(name[1]);
  if (a === b) return 13 * a + a;
  const hi = Math.min(a, b), lo = Math.max(a, b);
  return name[2] === 's' ? 13 * hi + lo : 13 * lo + hi;
}
export const classCombos = (c) => { const i = Math.floor(c / 13), j = c % 13; return i === j ? 6 : i < j ? 4 : 12; };

export function positionLabel(p) { return p === 'ip' ? 'in position' : 'out of position'; }
