// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import swipeReviewHTML from './swipe-review.html';
import { extractFunction } from './extract-function.test-helper.mjs';

const SHA = 'ab'.repeat(32);
const CASE_ID = '2f3a1c48-9d5e-4b17-9c0a-6e8b1d7f4a20';
const CASE_URL = `https://relay.admin.divine.video/age-review?case=${CASE_ID}`;
const LIFT_BLOCK = 'The account that owns this file has an open age review.';

// Swipe review writes media decisions too, and a SAFE or AGE_RESTRICTED there is
// a lift that relay manager can refuse (#231). Run the page's real handler.
const mintSwipeFns = new Function('ctx', `
  const { document, window, fetch, setTimeout, console, reviewQueue, reviewedSha256s, showCurrentVideo, updateProgress } = ctx;
  let currentToast = null;
  let currentIndex = 0;
  let reviewedCount = 0;
  ${extractFunction(swipeReviewHTML, 'showToast', "undoBtn.className = 'toast-undo'")}
  ${extractFunction(swipeReviewHTML, 'hideToast', "toast.classList.add('hiding')")}
  ${extractFunction(swipeReviewHTML, 'moderationRefusal', 'failure.caseUrl')}
  ${extractFunction(swipeReviewHTML, 'offerRefusalCase', "startsWith('https://')")}
  ${extractFunction(swipeReviewHTML, 'handleAction', "'Quick review: ' + action")}
  ${extractFunction(swipeReviewHTML, 'skipVideo', 'currentIndex++')}
  return { handleAction, skipVideo, state: () => ({ currentIndex, reviewedCount }) };
`);

function node(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, className: '', textContent: '', children: [], removed: false, onclick: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild(child) { el.children.push(child); return child; },
    remove() { el.removed = true; }
  };
  return el;
}

// `responses` are what /admin/api/moderate answers, in order; a promise of one
// holds that answer back until the test settles it. `queue` is the cards in
// review order. `renderFails` makes drawing a card throw. `reviewed` is what
// this page load has already reviewed.
function swipeHarness(responses, previousAction = 'AGE_RESTRICTED', queue = [SHA], { renderFails = false, reviewed = [] } = {}) {
  const toasts = [];
  const opened = [];
  const fetches = [];
  let renders = 0;
  const body = node('body');
  body.appendChild = (child) => { toasts.push(child); return child; };
  // The card on screen. A swipe adds its swipe-<direction> class.
  const card = node('div');
  const reviewQueue = queue.map((sha256) => ({ sha256, action: previousAction, isUntriaged: false }));
  const fns = mintSwipeFns({
    document: { createElement: node, body, querySelector: (selector) => (selector === '.video-card-swipe' ? card : null) },
    window: { open: (...args) => opened.push(args) },
    setTimeout: () => 0,
    console: { error: () => {}, log: () => {} },
    reviewQueue,
    reviewedSha256s: new Set(reviewed),
    showCurrentVideo: () => {
      renders += 1;
      if (renderFails) throw new Error('could not draw the card');
    },
    updateProgress: () => {},
    fetch: async (url, init) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      const response = await responses.shift();
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body
      };
    }
  });
  const latest = () => toasts[toasts.length - 1];
  const text = (toast) => toast.children.find((c) => c.className === 'toast-message')?.textContent;
  const button = (toast) => toast.children.find((c) => c.className === 'toast-undo') ?? null;
  return { ...fns, card, reviewQueue, toasts, opened, fetches, latest, text, button, renders: () => renders };
}

const REFUSED = {
  status: 409,
  body: { success: false, error: LIFT_BLOCK, code: 'age_review_active', caseId: CASE_ID, state: 'open_reported', caseUrl: CASE_URL }
};

describe('swipe review media decisions refused by the lift check', () => {
  it('offers the case when an approve is refused, and does not move on', async () => {
    const h = swipeHarness([REFUSED]);
    h.card.classList.add('swipe-right');

    await h.handleAction(SHA, 'SAFE');

    expect(h.fetches[0].url).toBe(`/admin/api/moderate/${SHA}`);
    expect(h.text(h.latest())).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
    const action = h.button(h.latest());
    expect(action.textContent).toBe('Open case');
    action.onclick();
    expect(h.opened).toEqual([[CASE_URL, '_blank', 'noopener']]);
    expect(h.state()).toEqual({ currentIndex: 0, reviewedCount: 0 });
    // The swipe left the card faded out; drawing it again brings it back.
    expect(h.renders()).toBe(1);
  });

  it('leaves the card as it is when a key-press approve is refused', async () => {
    const h = swipeHarness([REFUSED]);

    await h.handleAction(SHA, 'SAFE');

    expect(h.text(h.latest())).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
    // Nothing faded it, so redrawing would only restart the video.
    expect(h.renders()).toBe(0);
  });

  it('does not report a saved decision as failed when the next card cannot be drawn', async () => {
    const h = swipeHarness([{ status: 200, body: { success: true } }], 'AGE_RESTRICTED', [SHA], { renderFails: true });

    await h.handleAction(SHA, 'SAFE');

    expect(h.state()).toEqual({ currentIndex: 1, reviewedCount: 1 });
    expect(h.renders()).toBe(1);
    expect(h.text(h.latest())).toBe('Video approved');
  });

  it('offers the case when an Undo back to a lift is refused', async () => {
    const h = swipeHarness([{ status: 200, body: { success: true } }, REFUSED], 'SAFE');

    await h.handleAction(SHA, 'PERMANENT_BAN');
    // The toast does not await its action, so let the undo's fetch settle.
    h.button(h.latest()).onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.fetches[1].body.action).toBe('SAFE');
    expect(h.text(h.latest())).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
    expect(h.button(h.latest()).textContent).toBe('Open case');
  });

  it('says why when an Undo is refused without a case', async () => {
    const h = swipeHarness([
      { status: 200, body: { success: true } },
      { status: 502, body: { success: false, error: 'Could not confirm with relay manager', code: 'lift_check_unavailable' } }
    ], 'SAFE');

    await h.handleAction(SHA, 'PERMANENT_BAN');
    h.button(h.latest()).onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.text(h.latest())).toBe('Undo failed: Could not confirm with relay manager');
    expect(h.button(h.latest())).toBeNull();
  });

  it('says why when a refusal names no case', async () => {
    const h = swipeHarness([{
      status: 502,
      body: { success: false, error: 'Could not confirm with relay manager', code: 'lift_check_unavailable' }
    }]);

    await h.handleAction(SHA, 'SAFE');

    expect(h.text(h.latest())).toBe('Failed to update: Could not confirm with relay manager');
    expect(h.button(h.latest())).toBeNull();
  });
});

// An answer the moderator is not waiting on: they skipped on, or decided the
// same card twice, while the lift check was still out.
describe('swipe review answers that arrive after the moderator moved on', () => {
  const NEXT = 'cd'.repeat(32);
  const LAST = 'ef'.repeat(32);
  const OK = { status: 200, body: { success: true } };

  function held() {
    let settle;
    const answer = new Promise((resolve) => { settle = resolve; });
    return { answer, settle };
  }

  it('leaves the card the moderator skipped to alone when the lift is refused', async () => {
    const first = held();
    const h = swipeHarness([first.answer], 'AGE_RESTRICTED', [SHA, NEXT]);
    h.card.classList.add('swipe-right');

    const pending = h.handleAction(SHA, 'SAFE');
    h.skipVideo();
    first.settle(REFUSED);
    await pending;

    expect(h.state()).toEqual({ currentIndex: 1, reviewedCount: 0 });
    // Drawn once, by the skip: the refusal did not redraw the card after it.
    expect(h.renders()).toBe(1);
    expect(h.text(h.latest())).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
  });

  it('does not skip a further card when an allowed lift answers after a skip', async () => {
    const first = held();
    const h = swipeHarness([first.answer], 'AGE_RESTRICTED', [SHA, NEXT, LAST]);

    const pending = h.handleAction(SHA, 'SAFE');
    h.skipVideo();
    first.settle(OK);
    await pending;

    expect(h.state()).toEqual({ currentIndex: 1, reviewedCount: 1 });
  });

  it('moves on once when the same card is decided twice before either answers', async () => {
    const first = held();
    const second = held();
    const h = swipeHarness([first.answer, second.answer], 'AGE_RESTRICTED', [SHA, NEXT, LAST]);

    const pending = [h.handleAction(SHA, 'SAFE'), h.handleAction(SHA, 'SAFE')];
    first.settle(OK);
    second.settle(OK);
    await Promise.all(pending);

    expect(h.state().currentIndex).toBe(1);
  });

  it('brings back the decided card on Undo when its answer came after two skips', async () => {
    const first = held();
    const h = swipeHarness([first.answer, OK], 'AGE_RESTRICTED', [SHA, NEXT, LAST]);

    const pending = h.handleAction(SHA, 'SAFE');
    h.skipVideo();
    h.skipVideo();
    first.settle(OK);
    await pending;
    h.button(h.latest()).onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.text(h.latest())).toBe('Action undone');
    expect(h.state().currentIndex).toBe(0);
  });

  it('keeps the review where it is on Undo when the decided card left the queue', async () => {
    const first = held();
    const h = swipeHarness([first.answer, OK], 'AGE_RESTRICTED', [SHA, NEXT]);

    const pending = h.handleAction(SHA, 'SAFE');
    // A reload drops the card while its answer is still out.
    h.reviewQueue.splice(0, 1);
    first.settle(OK);
    await pending;
    h.button(h.latest()).onclick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.text(h.latest())).toBe('Action undone');
    expect(h.state().currentIndex).toBe(0);
  });

  it('counts a card reviewed before the queue was reloaded', async () => {
    // Changing the Since filter zeroes the count and reloads the queue, but
    // keeps the hashes reviewed so far, so a card can come back and be decided again.
    const h = swipeHarness([OK], 'AGE_RESTRICTED', [SHA, NEXT], { reviewed: [SHA] });

    await h.handleAction(SHA, 'SAFE');

    expect(h.state()).toEqual({ currentIndex: 1, reviewedCount: 1 });
  });
});

// The page's real drag handlers, with the drag state they share.
const mintSwipeHandlers = new Function('ctx', `
  const { document, swipeAction } = ctx;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let swipeDirection = null;
  let detachSwipeHandlers = null;
  // An empty queue, so showCurrentVideo takes its "finished" branch.
  let reviewQueue = [];
  let currentIndex = 0;
  let reviewedCount = 0;
  // The Since filter's reload, which the test does not run.
  const loadReviewQueue = () => {};
  ${extractFunction(swipeReviewHTML, 'setupSwipeHandlers', "swipeAction(card, 'right', sha256, 'SAFE')")}
  ${extractFunction(swipeReviewHTML, 'showCurrentVideo', '// Finished all reviews')}
  ${extractFunction(swipeReviewHTML, 'applySinceFilter', 'Reset queue and reload with new filter')}
  return { setupSwipeHandlers, showCurrentVideo, applySinceFilter };
`);

describe('swipe review drag handlers', () => {
  // A document that keeps its listeners in the order they were added, as a
  // browser does, and a card that keeps its own.
  function dragHarness() {
    const listeners = [];
    const document = {
      getElementById: () => ({ style: {}, innerHTML: '' }),
      addEventListener: (type, fn) => { listeners.push({ type, fn }); },
      removeEventListener: (type, fn) => {
        const at = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      }
    };
    const swipes = [];
    const { setupSwipeHandlers, showCurrentVideo, applySinceFilter } = mintSwipeHandlers({
      document,
      swipeAction: (_card, _direction, sha256, action) => { swipes.push({ sha256, action }); }
    });
    const card = (sha256) => {
      const own = {};
      return {
        style: {},
        classList: { add: () => {}, remove: () => {} },
        getAttribute: (name) => (name === 'data-sha256' ? sha256 : null),
        querySelector: () => ({ classList: { toggle: () => {} } }),
        querySelectorAll: () => [],
        addEventListener: (type, fn) => { own[type] = fn; },
        press: (x) => own.mousedown({ clientX: x, clientY: 0 })
      };
    };
    const dispatch = (type, event) => listeners.filter((l) => l.type === type).forEach((l) => l.fn(event));
    const moveRight = () => dispatch('mousemove', { clientX: 200, clientY: 0, preventDefault: () => {} });
    const release = () => dispatch('mouseup', {});
    const dragRight = (onCard) => {
      onCard.press(0);
      moveRight();
      release();
    };
    return { setupSwipeHandlers, showCurrentVideo, applySinceFilter, card, dragRight, moveRight, release, swipes, listeners };
  }

  it('sends a swipe on a later card for that card, not the first one shown', () => {
    const h = dragHarness();
    const first = h.card('1'.repeat(64));
    const second = h.card('2'.repeat(64));

    h.setupSwipeHandlers(first);
    h.setupSwipeHandlers(second);
    h.dragRight(second);

    expect(h.swipes).toEqual([{ sha256: '2'.repeat(64), action: 'SAFE' }]);
    // One card's worth of document listeners, however many cards were shown.
    expect(h.listeners).toHaveLength(4);
  });

  it('decides nothing when a drag is released after its card was replaced', () => {
    const h = dragHarness();
    const first = h.card('1'.repeat(64));
    const second = h.card('2'.repeat(64));

    h.setupSwipeHandlers(first);
    first.press(0);
    h.moveRight();
    // A late answer moves the review on while the button is still down, and
    // the moderator keeps dragging before letting go.
    h.setupSwipeHandlers(second);
    h.moveRight();
    h.release();

    expect(h.swipes).toEqual([]);
  });

  it('decides nothing when the queue finishes while the last card is held', () => {
    const h = dragHarness();
    const last = h.card('3'.repeat(64));

    h.setupSwipeHandlers(last);
    last.press(0);
    h.moveRight();
    // A late answer for the last card ends the queue while the button is down.
    h.showCurrentVideo();
    h.release();

    expect(h.swipes).toEqual([]);
    expect(h.listeners).toHaveLength(0);
  });

  it('decides nothing when the queue is reloaded while a card is held', () => {
    const h = dragHarness();
    const held = h.card('4'.repeat(64));

    h.setupSwipeHandlers(held);
    held.press(0);
    h.moveRight();
    // Changing the Since filter or queue order empties the queue and reloads it.
    h.applySinceFilter();
    h.release();

    expect(h.swipes).toEqual([]);
    expect(h.listeners).toHaveLength(0);
  });
});

describe('swipe review provenance UI hooks', () => {
  it('contains creator info modal and provenance helpers', () => {
    expect(swipeReviewHTML).toContain('Creator Info');
    expect(swipeReviewHTML).toContain('openCreatorInfo');
    expect(swipeReviewHTML).toContain('renderProvenanceBadge');
    expect(swipeReviewHTML).toContain('creator-info-modal');
  });

  it('contains C2PA/ProofMode badge rendering', () => {
    expect(swipeReviewHTML).toContain('renderC2paBadge');
    expect(swipeReviewHTML).toContain('formatC2paSupportLine');
    expect(swipeReviewHTML).toContain('Valid ProofMode');
    expect(swipeReviewHTML).toContain('Valid C2PA');
    expect(swipeReviewHTML).toContain('Valid but AI-signed');
    expect(swipeReviewHTML).toContain('Invalid Proof');
    expect(swipeReviewHTML).toContain('c2pa-badge');
  });

  it('renders poster thumbnails before video playback starts', () => {
    expect(swipeReviewHTML).toContain('const posterUrl = escapeHtml(video.thumbnailUrl || \'\');');
    expect(swipeReviewHTML).toContain('poster="${posterUrl}"');
  });
});
