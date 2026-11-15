import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as flow from '../desktop/plugin.js?performance-test';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const { document } = dom.window;

// The mark label placement as it was before measuring in batches, frozen as the reference with the helpers it used.
const GAP = 4, ROW_GAP = 2, TIGHT = 16;
const overlap = (box, other, gap) => !(box.right + gap <= other.left || box.left >= other.right + gap || box.bottom <= other.top || box.top >= other.bottom);
function referencePlace(layer) {
  const bounds = layer.getBoundingClientRect();
  if (!(bounds.width > 0)) return;
  const flags = [...layer.querySelectorAll('.su-flag')].sort((a, b) => Number(a.dataset.t) - Number(b.dataset.t));
  for (const flag of flags) flag.style.setProperty('--su-flag-row', '0');
  const boxes = flags.map(flag => flag.getBoundingClientRect()), rows = [];
  flags.forEach((flag, index) => {
    const box = boxes[index];
    let row = rows.findIndex(right => right + ROW_GAP <= box.left);
    if (row < 0) { row = rows.length; rows.push(0); }
    rows[row] = box.right;
    flag.style.setProperty('--su-flag-row', String(row));
    flag.dataset.row = String(row);
  });
  const waste = [...layer.querySelectorAll('.su-waste')], tight = waste.map(node => node.getBoundingClientRect().height < TIGHT);
  waste.forEach((node, index) => { node.dataset.tight = String(tight[index]); });
  const obstacles = [...layer.querySelectorAll('.su-reset-dot, .su-flag')].map(node => node.getBoundingClientRect()), placed = [];
  for (const label of [...layer.querySelectorAll('.su-waste-text'), ...layer.querySelectorAll('.su-reset-text')]) {
    label.dataset.hidden = 'false';
    let fit = null;
    for (const side of ['right', 'left']) {
      label.dataset.side = side;
      const box = label.getBoundingClientRect();
      const inside = box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5;
      if (inside && placed.every(other => !overlap(box, other, GAP)) && obstacles.every(other => !overlap(box, other, 0))) { fit = box; break; }
    }
    if (fit) placed.push(fit); else { label.dataset.side = 'right'; label.dataset.hidden = 'true'; }
  }
}

function random(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
const rect = (left, width, top, height) => ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top });
// jsdom has no layout. Each synthetic node carries its geometry: marks their x share and level, labels their width, flags their width; a label's box follows the side it currently has, as the plugin's CSS places it.
function geometry(width) {
  return function () {
    if (this.classList.contains('su-marks')) return rect(0, width, 0, 200);
    const anchor = this.closest('.su-reset, .su-waste, .su-flag'), x = parseFloat(anchor?.style.left) / 100 * width;
    const y = Number(this.closest('[data-y]')?.dataset.y ?? 100);
    if (this.matches('.su-waste-text, .su-reset-text')) { const w = Number(this.dataset.w); return this.dataset.side === 'left' ? rect(x - 6 - w, w, y - 7, 14) : rect(x + 6, w, y - 7, 14); }
    if (this.matches('.su-reset-dot')) return rect(x - 4, 8, y - 4, 8);
    if (this.matches('.su-flag')) { const row = Number(this.style.getPropertyValue('--su-flag-row') || 0); return rect(x - 1, Number(this.dataset.w), -18 - row * 16, 14); }
    if (this.matches('.su-waste')) return rect(x, 0, y, Number(this.dataset.h));
    return rect(0, 0, 0, 0);
  };
}
// A dense layer: projected resets with labels, past resets without, waste arrows with labels, and flags, many sharing nearby x.
function layer(rng, count) {
  const node = document.createElement('div');
  node.className = 'su-marks';
  for (let index = 0; index < count; index++) {
    const left = `${Math.round(rng() * 1000) / 10}%`, y = String(Math.round(rng() * 180) + 10), kind = rng();
    if (kind < 0.45) {
      const group = document.createElement('div');
      group.className = 'su-reset'; group.dataset.kind = rng() < 0.8 ? 'projected' : 'past'; group.style.left = left;
      for (let stack = 0, depth = 1 + Math.floor(rng() * 3); stack < depth; stack++) {
        const mark = document.createElement('span');
        mark.className = 'su-reset-mark'; mark.dataset.y = String(Math.max(0, Number(y) - stack * 12));
        mark.innerHTML = `<span class="su-reset-dot"></span>${group.dataset.kind === 'projected' ? `<span class="su-reset-text" data-side="${rng() < 0.5 ? 'right' : 'left'}" data-hidden="${rng() < 0.3}" data-w="${30 + Math.floor(rng() * 50)}"></span>` : ''}`;
        group.append(mark);
      }
      node.append(group);
    } else if (kind < 0.8) {
      const waste = document.createElement('div');
      waste.className = 'su-waste'; waste.style.left = left; waste.dataset.y = y; waste.dataset.h = String(Math.floor(rng() * 40));
      waste.innerHTML = `<span class="su-waste-text" data-side="left" data-w="${40 + Math.floor(rng() * 40)}"></span>`;
      node.append(waste);
    } else {
      const flag = document.createElement('span');
      flag.className = 'su-flag'; flag.style.left = left; flag.dataset.t = String(Math.round(rng() * 1e6)); flag.dataset.w = String(10 + Math.floor(rng() * 14));
      node.append(flag);
    }
  }
  return node;
}
const outcome = node => [...node.querySelectorAll('.su-waste-text, .su-reset-text, .su-flag, .su-waste')].map(item => [item.className, item.dataset.side, item.dataset.hidden, item.dataset.row, item.dataset.tight, item.style.getPropertyValue('--su-flag-row')].join(':')).join('|');
function withGeometry(width, run) {
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = geometry(width);
  try { return run(); } finally { dom.window.HTMLElement.prototype.getBoundingClientRect = original; }
}

test('measuring both sides in batches places every label, flag row and tight arrow as one label at a time did', () => {
  let hidden = 0, left = 0;
  for (let seed = 1; seed <= 250; seed++) {
    const rng = random(seed), width = [120, 240, 400, 900][seed % 4];
    const reference = layer(rng, 1 + Math.floor(rng() * 24)), candidate = reference.cloneNode(true);
    document.body.append(reference, candidate);
    withGeometry(width, () => { referencePlace(reference); flow.placeMarkLabels(candidate); });
    assert.equal(outcome(candidate), outcome(reference), `seed ${seed}`);
    hidden += candidate.querySelectorAll('[data-hidden="true"]').length;
    left += candidate.querySelectorAll('[data-side="left"]').length;
    reference.remove(); candidate.remove();
  }
  assert.ok(hidden > 50 && left > 50, 'the generated layers exercise hidden and left-placed labels');
});

test('placing the mark labels uses a bounded number of write-to-measurement phases, however many labels it holds', () => {
  // JSDOM has no layout: count geometry reads after attribute writes, the boundaries where a browser may have to flush layout.
  const phases = node => {
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(node, { attributes: true, subtree: true });
    let count = 0;
    const measure = geometry(400);
    const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () { if (observer.takeRecords().length) count++; return measure.call(this); };
    try { flow.placeMarkLabels(node); } finally { dom.window.HTMLElement.prototype.getBoundingClientRect = original; observer.disconnect(); }
    return { count, labels: node.querySelectorAll('.su-waste-text, .su-reset-text').length };
  };
  const few = phases(layer(random(3), 2)), many = phases(layer(random(4), 60));
  assert.ok(many.labels >= 30, `the dense layer holds many labels (${many.labels})`);
  // Flag rows, waste heights and obstacles each read after the previous step's writes; then one measurement phase for every label's right side and one for every left side.
  assert.ok(many.count <= 5, `five write-to-measurement phases at most (${many.count})`);
  assert.ok(many.count <= few.count + 2, `no more than a two-label layer needs, give or take its flags and arrows (${few.count} and ${many.count})`);
});
