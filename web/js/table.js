// Renders a table model (oval felt, six seats with the hero at the bottom,
// dealer button, stacks, bets, pot, board) and animates the change from one
// model to the next: cards dealt from the button / deck, chips pushed from a
// player's plate to the bet spot, bets swept into the pot, folds mucked,
// numbers counting, the pot pushed to the winner.
//
// All motion uses transform/opacity through the Web Animations API, with
// positions measured from the real elements, so it fits any table size.
// finishAll() ends every running animation at once (used to skip).
import { h, clear, fmtBb, reducedMotion } from './ui.js';
import { SEATS, cardEl } from './poker.js';
import { sound } from './sound.js';

// Slot 0 is the bottom (hero); slots go clockwise (to the hero's left).
const SLOT_CLASS = ['s0', 's1', 's2', 's3', 's4', 's5'];
// A table with fewer players (tournament: m.seats holds only the seats in the game) spreads them
// over these slots, in seat order clockwise from the hero.
const LAYOUT = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 2, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };
const BET_BASE = 'translate(-50%, -50%)';
const r2 = (x) => Math.round(x * 100) / 100;

/** Seat that takes the pot at the end of the hand (null for a split / unknown). */
function winnerOf(m) {
  const end = m.end;
  if (!end) return null;
  if (end.reason === 'hero_fold') return m.villainSeat;
  if (end.reason === 'villain_fold') return m.heroSeat;
  if (end.showdown?.winner === 'hero') return m.heroSeat;
  if (end.showdown?.winner === 'villain') return m.villainSeat;
  return null;
}
function chipCount(amount) { return amount < 2 ? 1 : amount < 8 ? 2 : amount < 25 ? 3 : 4; }
function middleOf(m) {
  const bets = Object.values(m.seats).reduce((a, s) => a + (s.bet || 0), 0);
  return { bets: r2(bets), middle: r2(m.pot - bets) };
}

export function createTable(root) {
  const el = h('div.table', { role: 'group', 'aria-label': 'Poker table' });
  root.append(el);
  let running = [];  // WAAPI animations and number tweens ({ finish(), finished })
  let epoch = 0;     // bumped by finishAll(): an in-flight transition stops adding motion

  // ---------- static drawing ----------
  // Optional model fields (tournament): m.noBoard (no board slots), m.note (a line under the pot),
  // m.dealer (the seat with the button, default BTN), seats[x].backs (face-down cards for a seat
  // still in the hand), seats[x].allin.
  function render(m) {
    clear(el);
    const present = SEATS.filter((s) => m.seats[s]);
    const layout = LAYOUT[present.length] || LAYOUT[6];
    const heroAt = present.indexOf(m.heroSeat);
    const slotOf = (seat) => layout[(present.indexOf(seat) - heroAt + present.length) % present.length];
    el.append(h('div.felt', h('div.felt-inner')));
    const { bets, middle } = middleOf(m);
    const won = winnerOf(m); // at the end the pot has gone to the winner
    el.append(h('div.center',
      h('div.pot', { 'aria-label': won ? `${won} won ${fmtBb(m.pot)} big blinds` : `Pot ${fmtBb(m.pot)} big blinds` },
        h('span.pot-label', won ? (won === m.heroSeat ? 'You won' : `${won} won`) : 'Pot'), ' ', h('span.num', { dataset: { num: 'pot' } }, fmtBb(middle > 0 ? middle : m.pot)),
        bets > 0 && middle > 0 ? h('span.pot-total', ` (total ${fmtBb(m.pot)})`) : null),
      m.noBoard ? null : h('div.board', { 'aria-label': m.board.length ? `Board ${m.board.join(' ')}` : 'No board yet' },
        [0, 1, 2, 3, 4].map((i) => (m.board[i]
          ? cardEl(m.board[i], { size: 'md', key: `b${i}` })
          : h('span.card.card-md.card-slot', { 'aria-hidden': 'true' })))),
      m.note ? h('div.table-note', m.note) : null));

    const villainShown = m.end && m.end.reason === 'showdown' && m.end.showdown ? m.end.showdown.villainHand : null;
    const dealerSeat = m.dealer || 'BTN';
    present.forEach((seat) => {
      const slot = slotOf(seat);
      const s = m.seats[seat];
      const isHero = seat === m.heroSeat, isVillain = seat === m.villainSeat;
      const classes = ['seat', SLOT_CLASS[slot]];
      if (s.folded) classes.push('folded');
      if (isHero) classes.push('hero');
      if (isVillain) classes.push('villain');
      if (m.acting === seat) classes.push('acting');
      if (m.decision && isHero) classes.push('to-act');
      const cards = [];
      if (!s.folded && isHero) {
        m.puzzle.hero.hand.forEach((c, i) => cards.push(cardEl(c, { size: 'lg', key: `h${i}` })));
      } else if (!s.folded && (isVillain || s.backs)) {
        for (let i = 0; i < 2; i++) cards.push(cardEl(isVillain && villainShown ? villainShown[i] : null, { size: 'sm', key: `v${i}` }));
      }
      const label = `${seat}${isHero ? ' (you)' : ''}${s.folded ? ', folded' : ''}${s.allin ? ', all-in' : ''}, stack ${fmtBb(s.stack)} big blinds`;
      el.append(h(`div.${classes.join('.')}`, { 'aria-label': label, dataset: { seat } },
        h('div.seat-cards', cards),
        h('div.seat-plate',
          h('span.seat-pos', seat, isHero ? h('span.you', 'You') : null),
          h('span.seat-stack.num', { dataset: { num: `stack-${seat}` } }, fmtBb(won === seat ? r2(s.stack + m.pot) : s.stack))),
        s.last && !s.folded ? h(`span.seat-act.act-${s.lastKind}`, s.last) : null,
        s.folded && s.last ? h('span.seat-act.act-fold', 'Fold') : null));
      if (s.bet > 0) {
        el.append(h(`div.bet.b${slot}`, { dataset: { seat } },
          h('span.chipstack', { 'aria-hidden': 'true' }, Array.from({ length: chipCount(s.bet) }, () => h('span.chipico'))),
          h('span.num', { dataset: { num: `bet-${seat}` } }, fmtBb(s.bet))));
      }
      if (seat === dealerSeat) el.append(h(`div.dealer.d${slot}`, { title: 'Dealer button', 'aria-label': 'Dealer button' }, 'D'));
    });
  }

  // ---------- helpers ----------
  const q = (sel) => el.querySelector(sel);
  const centerOf = (node) => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const plate = (seat) => q(`.seat[data-seat="${seat}"] .seat-plate`);
  function track(a) {
    running.push(a);
    const p = a.finished.catch(() => {});
    p.then(() => { const i = running.indexOf(a); if (i >= 0) running.splice(i, 1); });
    return p;
  }

  /** Move `node` from point `from` to where it is now (FLIP). */
  function flyIn(node, from, { duration = 360, delay = 0, flip = false, base = '', scale = 0.85, easing = 'cubic-bezier(.2,.75,.25,1)' } = {}) {
    if (!node) return Promise.resolve();
    if (reducedMotion()) return track(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, fill: 'backwards' }));
    const to = centerOf(node);
    const dx = from.x - to.x, dy = from.y - to.y;
    const start = `${base} translate(${dx}px, ${dy}px) scale(${scale})${flip ? ' scaleX(0.08)' : ''}`;
    const frames = flip
      ? [{ transform: start, opacity: 0.6 }, { transform: `${base} scaleX(0.08)`, opacity: 1, offset: 0.62 }, { transform: base || 'none', opacity: 1 }]
      : [{ transform: start, opacity: 0.6 }, { transform: base || 'none', opacity: 1 }];
    return track(node.animate(frames, { duration, delay, easing, fill: 'backwards' }));
  }
  /** Move `node` away to point `to` and fade it (before a re-render). */
  function flyOut(node, to, { duration = 260, base = '', scale = 0.7 } = {}) {
    if (!node) return Promise.resolve();
    if (reducedMotion()) return track(node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }));
    const from = centerOf(node);
    return track(node.animate([
      { transform: base || 'none', opacity: 1 },
      { transform: `${base} translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${scale})`, opacity: 0 },
    ], { duration, easing: 'ease-in', fill: 'forwards' }));
  }
  function pulse(node, { big = false } = {}) {
    if (!node || reducedMotion()) return Promise.resolve();
    const s = big ? 1.12 : 1.07;
    return track(node.animate([{ transform: 'scale(1)' }, { transform: `scale(${s})` }, { transform: 'scale(1)' }], { duration: big ? 360 : 260, easing: 'ease-out' }));
  }
  /** Count a number element from `from` to its current value. */
  function count(node, from, to, duration = 380) {
    if (!node || from === to || from === undefined) return Promise.resolve();
    let done = false, raf = 0, resolve;
    const finished = new Promise((r) => { resolve = r; });
    const t0 = performance.now();
    const set = (v) => { node.textContent = fmtBb(Math.round(v * 10) / 10); }; // 1 decimal while counting
    const stop = () => { if (done) return; done = true; cancelAnimationFrame(raf); node.textContent = fmtBb(to); resolve(); };
    const step = (t) => {
      const k = Math.min(1, (t - t0) / duration);
      set(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step); else stop();
    };
    set(from);
    raf = requestAnimationFrame(step);
    return track({ finish: stop, finished });
  }
  const settle = (list) => Promise.all(list);

  // ---------- transitions ----------
  function snapshot(m) {
    const seats = {};
    for (const [k, s] of Object.entries(m.seats)) seats[k] = { stack: s.stack, bet: s.bet, folded: s.folded };
    return { pot: m.pot, middle: middleOf(m).middle, board: m.board.slice(), seats, end: !!m.end };
  }

  /** Start of a hand: blinds pushed out, hole cards dealt from the button. */
  async function dealIn(m) {
    const my = ++epoch;
    render(m);
    const dealer = q('.dealer'); const from = dealer ? centerOf(dealer) : centerOf(q('.pot'));
    const order = [q(`.seat[data-seat="${m.villainSeat}"] [data-key="v0"]`), q('[data-key="h0"]'), q(`.seat[data-seat="${m.villainSeat}"] [data-key="v1"]`), q('[data-key="h1"]')];
    const list = [];
    for (const seat of ['SB', 'BB']) {
      const b = q(`.bet[data-seat="${seat}"]`);
      if (b) list.push(flyIn(b, centerOf(plate(seat)), { base: BET_BASE, duration: 300, scale: 0.6 }));
    }
    sound.chips(false);
    order.forEach((c, i) => {
      if (!c) return;
      const isHero = c.dataset.key.startsWith('h');
      list.push(flyIn(c, from, { delay: 120 + i * 130, duration: 340, flip: isHero, scale: 0.6 }));
    });
    sound.deal(order.filter(Boolean).length, 0.13, 0.12);
    await settle(list);
    if (my !== epoch) render(m);
  }

  /**
   * Animate from `prev` (a snapshot taken before the step) to model `m`.
   * Resolves when the motion is over (or immediately after finishAll()).
   */
  async function transition(prev, m, step) {
    const my = ++epoch;
    const alive = () => my === epoch;
    const potPoint = centerOf(q('.pot') || el);

    // --- before redrawing: sweep bets into the pot, muck folded cards ---
    const pre = [];
    const newlyFolded = Object.keys(m.seats).filter((k) => m.seats[k].folded && !prev.seats[k].folded);
    for (const seat of newlyFolded) {
      const cards = q(`.seat[data-seat="${seat}"] .seat-cards`);
      if (cards && cards.children.length) { pre.push(flyOut(cards, potPoint, { duration: 240, scale: 0.6 })); sound.fold(); }
    }
    const streetEnds = step.type === 'deal' || (step.type === 'end' && Object.values(prev.seats).some((s) => s.bet > 0));
    if (streetEnds) {
      const bets = [...el.querySelectorAll('.bet')];
      if (bets.length) {
        bets.forEach((b) => pre.push(flyOut(b, potPoint, { duration: 260, base: BET_BASE, scale: 0.6 })));
        sound.chips(false);
      }
    }
    if (pre.length) await settle(pre);
    render(m);
    if (!alive()) return;

    // --- after redrawing: what is new flies in, numbers count ---
    const post = [];
    // board cards from the deck (just above the board), one at a time, flipping face up
    if (m.board.length > prev.board.length) {
      const board = q('.board'); const deck = centerOf(board);
      deck.y -= board.getBoundingClientRect().height * 1.1;
      const n = m.board.length - prev.board.length;
      for (let i = 0; i < n; i++) {
        post.push(flyIn(q(`.board [data-key="b${prev.board.length + i}"]`), deck, { delay: i * 120, duration: 360, flip: true, scale: 0.7 }));
      }
      sound.deal(n, 0.12);
    }
    // chips from the plate to the bet spot
    for (const [seat, s] of Object.entries(m.seats)) {
      const before = prev.seats[seat].bet || 0;
      if (s.bet > before && !streetEnds) {
        const b = q(`.bet[data-seat="${seat}"]`);
        const allin = s.stack === 0;
        post.push(flyIn(b, centerOf(plate(seat)), { base: BET_BASE, duration: allin ? 420 : 340, scale: allin ? 0.9 : 0.6 }));
        post.push(count(b?.querySelector('.num'), before, s.bet));
        if (allin) post.push(pulse(plate(seat), { big: true }));
        sound.chips(s.bet - before > m.pot / 3 || allin);
      }
      post.push(count(q(`[data-num="stack-${seat}"]`), prev.seats[seat].stack, s.stack));
    }
    // a check taps the plate
    const kind = step.type === 'action' ? step.kind : step.type === 'villain' ? step.action.kind
      : step.type === 'decision' && step.mainLine ? step.options.find((o) => o.id === step.mainLine)?.kind : null;
    if (kind === 'check') { post.push(pulse(plate(step.seat || m.heroSeat))); sound.check(); }
    // the pot counts up when a street's bets were swept in
    const mid = middleOf(m).middle;
    if (streetEnds && mid !== prev.middle) post.push(count(q('[data-num="pot"]'), prev.middle, mid > 0 ? mid : m.pot));
    // showdown: villain's cards flip over
    if (step.type === 'end' && m.end?.reason === 'showdown') {
      for (const i of [0, 1]) post.push(flyIn(q(`.seat[data-seat="${m.villainSeat}"] [data-key="v${i}"]`), centerOf(q(`.seat[data-seat="${m.villainSeat}"] .seat-cards`)), { delay: i * 90, duration: 320, flip: true, scale: 1 }));
      sound.deal(2, 0.09);
    }
    await settle(post);
    if (!alive()) return;
    if (step.type === 'end') await awardPot(m);
  }

  /** The pot slides to the winner, whose stack counts up and plate glows. */
  async function awardPot(m) {
    const my = epoch;
    const winner = winnerOf(m);
    if (!winner) return;
    const potEl = q('.pot'); const pl = plate(winner);
    if (!potEl || !pl) return;
    const from = centerOf(potEl), to = centerOf(pl);
    const tr = el.getBoundingClientRect();
    const chips = h('div.flychips', { 'aria-hidden': 'true', style: { left: `${from.x - tr.left}px`, top: `${from.y - tr.top}px` } },
      h('span.chipstack', h('span.chipico'), h('span.chipico'), h('span.chipico')));
    el.append(chips);
    const list = [];
    if (reducedMotion()) list.push(track(chips.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })));
    else list.push(track(chips.animate([{ transform: BET_BASE, opacity: 1 }, { transform: `${BET_BASE} translate(${to.x - from.x}px, ${to.y - from.y}px) scale(0.7)`, opacity: 0.2 }], { duration: 460, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' })));
    sound.chips(true);
    const stackEl = q(`[data-num="stack-${winner}"]`);
    const stack = m.seats[winner].stack;
    list.push(count(stackEl, stack, r2(stack + m.pot), 520));
    const glow = h('span.win-glow', { 'aria-hidden': 'true' });
    pl.append(glow);
    list.push(track(glow.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: 900, delay: 300, fill: 'both' })));
    await settle(list);
    if (my === epoch) chips.remove();
  }

  /** End every running animation now (skip). */
  function finishAll() {
    epoch++;
    const list = running; running = [];
    for (const a of list) { try { a.finish(); } catch { /* already done */ } }
    el.querySelectorAll('.flychips').forEach((n) => n.remove());
  }

  return { el, render, snapshot, dealIn, transition, finishAll };
}
