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
  const { document, window, fetch, setTimeout, console, reviewQueue, reviewedSha256s, showCurrentVideo } = ctx;
  let currentToast = null;
  let currentIndex = 0;
  let reviewedCount = 0;
  ${extractFunction(swipeReviewHTML, 'showToast', "undoBtn.className = 'toast-undo'")}
  ${extractFunction(swipeReviewHTML, 'hideToast', "toast.classList.add('hiding')")}
  ${extractFunction(swipeReviewHTML, 'moderationRefusal', 'failure.caseUrl')}
  ${extractFunction(swipeReviewHTML, 'offerRefusalCase', "startsWith('https://')")}
  ${extractFunction(swipeReviewHTML, 'handleAction', "'Quick review: ' + action")}
  return { handleAction, state: () => ({ currentIndex, reviewedCount }) };
`);

function node(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, className: '', textContent: '', children: [], removed: false, onclick: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    appendChild(child) { el.children.push(child); return child; },
    remove() { el.removed = true; }
  };
  return el;
}

// `responses` are what /admin/api/moderate answers, in order.
function swipeHarness(responses, previousAction = 'AGE_RESTRICTED') {
  const toasts = [];
  const opened = [];
  const fetches = [];
  let renders = 0;
  const body = node('body');
  body.appendChild = (child) => { toasts.push(child); return child; };
  const fns = mintSwipeFns({
    document: { createElement: node, body },
    window: { open: (...args) => opened.push(args) },
    setTimeout: () => 0,
    console: { error: () => {}, log: () => {} },
    reviewQueue: [{ sha256: SHA, action: previousAction, isUntriaged: false }],
    reviewedSha256s: new Set(),
    showCurrentVideo: () => { renders += 1; },
    fetch: async (url, init) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      const response = responses.shift();
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
  return { ...fns, toasts, opened, fetches, latest, text, button, renders: () => renders };
}

const REFUSED = {
  status: 409,
  body: { success: false, error: LIFT_BLOCK, code: 'age_review_active', caseId: CASE_ID, state: 'open_reported', caseUrl: CASE_URL }
};

describe('swipe review media decisions refused by the lift check', () => {
  it('offers the case when an approve is refused, and does not move on', async () => {
    const h = swipeHarness([REFUSED]);

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
