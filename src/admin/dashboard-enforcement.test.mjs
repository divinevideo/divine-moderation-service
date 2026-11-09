// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Runs the dashboard's real enforcement and media-decision handlers and toast
// ABOUTME: against stubs so the age-review refusal path is covered by behaviour, not substrings

import { describe, expect, it } from 'vitest';
import dashboardHTML from './dashboard.html';
import { extractFunction } from './extract-function.test-helper.mjs';

// dashboard.html has no build step, so the rest of its suite asserts on source
// substrings. That signal is inverted for this path: dropping the structured
// `throw` kills the feature outright and every substring still matches, while
// reformatting a call that behaves identically fails. So pull the functions out
// of the HTML and actually run them.

const PUBKEY = 'b'.repeat(64);
const CASE_ID = '2f3a1c48-9d5e-4b17-9c0a-6e8b1d7f4a20';
const BLOCK_MESSAGE = 'This account is under age review. Restrict or clear it from the Age Review flow.';
const CASE_URL = `https://relay.admin.divine.video/age-review?case=${CASE_ID}`;

const SHOW_TOAST_SRC = extractFunction(dashboardHTML, 'showToast', "actionBtn.className = 'toast-action'");
const HIDE_TOAST_SRC = extractFunction(dashboardHTML, 'hideToast', "toast.classList.add('hiding')");
const UPDATE_SRC = extractFunction(dashboardHTML, 'updateUploaderEnforcement', 'offerRefusalCase(error, true)');
const REFUSAL_SRC = extractFunction(dashboardHTML, 'moderationRefusal', 'failure.caseUrl');
const OFFER_CASE_SRC = extractFunction(dashboardHTML, 'offerRefusalCase', "startsWith('https://')");

// workerd blocks the AsyncFunction constructor, but `new Function` is allowed and
// its generated body may declare an async function the ordinary way. The
// sources are dropped into one scope so the handler calls the page's real
// refusal helpers and toast.
const mintDashboardFns = new Function('ctx', `
  const {
    document, window, fetch, setTimeout, console,
    setLookupStatus, lookupVideo, loadVideos, currentLookupVideo
  } = ctx;
  let currentToast = null;
  ${SHOW_TOAST_SRC}
  ${HIDE_TOAST_SRC}
  ${REFUSAL_SRC}
  ${OFFER_CASE_SRC}
  ${UPDATE_SRC}
  return { showToast, updateUploaderEnforcement };
`);

function createNode(tag) {
  const classes = new Set();
  const node = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    onclick: null,
    children: [],
    removed: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    remove() {
      node.removed = true;
    }
  };
  return node;
}

// `response` is what the stubbed enforcement endpoint answers with.
function createHarness({ response, currentLookupVideo = null, refreshError = null } = {}) {
  const body = createNode('body');
  const toasts = [];
  const opened = [];
  const statusLines = [];
  const fetchCalls = [];
  const refreshes = [];
  const timers = [];

  const ctx = {
    document: {
      createElement: createNode,
      body
    },
    window: {
      open: (...args) => { opened.push(args); }
    },
    console: { error: () => {} },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    setLookupStatus: (message, isError = false) => { statusLines.push({ message, isError }); },
    lookupVideo: async (id) => {
      refreshes.push({ kind: 'lookupVideo', id });
      if (refreshError) throw refreshError;
    },
    loadVideos: async () => {
      refreshes.push({ kind: 'loadVideos' });
      if (refreshError) throw refreshError;
    },
    currentLookupVideo,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body
      };
    }
  };

  const fns = mintDashboardFns(ctx);

  // Every toast the page builds is appended to document.body; track them there
  // rather than wrapping showToast, so the assertions see the real DOM writes.
  const originalAppend = body.appendChild;
  body.appendChild = (child) => {
    toasts.push(child);
    return originalAppend(child);
  };

  return { ...fns, toasts, opened, statusLines, fetchCalls, refreshes, timers, body };
}

function latestToast(harness) {
  return harness.toasts[harness.toasts.length - 1];
}

function toastText(toast) {
  return toast.children.find((child) => child.className === 'toast-message')?.textContent;
}

function toastAction(toast) {
  return toast.children.find((child) => child.className === 'toast-action') ?? null;
}

async function runUnban(harness) {
  const button = createNode('button');
  button.innerHTML = 'Unban';
  await harness.updateUploaderEnforcement(
    PUBKEY,
    { relayBanned: false, reason: 'Relay ban removed by moderator' },
    button,
    'Relay ban removed'
  );
  return button;
}

describe('dashboard enforcement handler', () => {
  it('carries a 409 refusal past the throw and offers the case', async () => {
    const harness = createHarness({
      response: {
        status: 409,
        body: {
          success: false,
          error: BLOCK_MESSAGE,
          code: 'age_review_active',
          caseId: CASE_ID,
          state: 'restricted_pending_parental_consent',
          caseUrl: CASE_URL
        }
      }
    });

    const button = await runUnban(harness);

    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0].url)
      .toBe(`/admin/api/uploader/${encodeURIComponent(PUBKEY)}/enforcement`);
    expect(JSON.parse(harness.fetchCalls[0].init.body)).toEqual({
      relayBanned: false,
      reason: 'Relay ban removed by moderator'
    });

    // The refusal names the case, so the moderator is told which one and handed
    // a way in — not the generic red dead end this change exists to remove.
    const toast = latestToast(harness);
    expect(toastText(toast)).toBe(`${BLOCK_MESSAGE} (case ${CASE_ID})`);
    expect(toastAction(toast)?.textContent).toBe('Open case');
    expect(harness.timers[0]?.delay).toBe(10000);
    expect(harness.statusLines).toEqual([
      { message: `${BLOCK_MESSAGE} (case ${CASE_ID})`, isError: true }
    ]);

    toastAction(toast).onclick();
    expect(harness.opened).toEqual([[CASE_URL, '_blank', 'noopener']]);

    // A refusal is not a success: nothing was refreshed and the button is usable.
    expect(harness.refreshes).toEqual([]);
    expect(button.innerHTML).toBe('Unban');
    expect(button.disabled).toBe(false);
  });

  it('falls back to the plain toast when the refusal names no case', async () => {
    // The shape the server actually emits when it cannot trust the case id:
    // relayAdminField nulls a non-string or blank caseId, and caseUrl is built
    // only when caseId survived, so both arrive null together. The moderator
    // still learns the un-ban was refused and why — they just get no link.
    const harness = createHarness({
      response: {
        status: 409,
        body: {
          success: false,
          error: BLOCK_MESSAGE,
          code: 'age_review_active',
          caseId: null,
          caseUrl: null
        }
      }
    });

    await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastText(toast)).toBe(`User action failed: ${BLOCK_MESSAGE}`);
    expect(toastAction(toast)).toBeNull();
    expect(harness.opened).toEqual([]);
  });

  it('will not open a case link that is not https', async () => {
    const harness = createHarness({
      response: {
        status: 409,
        body: {
          success: false,
          error: BLOCK_MESSAGE,
          code: 'age_review_active',
          caseId: CASE_ID,
          // caseUrl arrives over the wire and is handed to window.open, so a
          // scheme that executes must never become a clickable button.
          caseUrl: 'javascript:alert(document.cookie)'
        }
      }
    });

    await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastAction(toast)).toBeNull();
    expect(toastText(toast)).toBe(`User action failed: ${BLOCK_MESSAGE}`);
    expect(harness.opened).toEqual([]);
  });

  it('leaves a retryable 503 as a plain toast', async () => {
    const harness = createHarness({
      response: {
        status: 503,
        body: {
          success: false,
          error: 'Could not check age-review status. Try again.',
          code: 'age_review_check_failed'
        }
      }
    });

    const button = await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastAction(toast)).toBeNull();
    expect(toastText(toast))
      .toBe('User action failed: Could not check age-review status. Try again.');
    expect(button.disabled).toBe(false);
  });

  it('leaves an uncoded 502 relay failure as a plain toast', async () => {
    const harness = createHarness({
      response: {
        status: 502,
        body: { success: false, error: 'Invalid pubkey' }
      }
    });

    await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastAction(toast)).toBeNull();
    expect(toastText(toast)).toBe('User action failed: Invalid pubkey');
  });

  it('confirms a successful change and refreshes, with no action button', async () => {
    const harness = createHarness({
      response: { status: 200, body: { success: true } }
    });

    const button = await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastText(toast)).toBe('Relay ban removed');
    expect(toastAction(toast)).toBeNull();
    expect(harness.statusLines).toEqual([
      { message: 'Relay ban removed', isError: false }
    ]);
    expect(harness.refreshes).toEqual([{ kind: 'loadVideos' }]);
    expect(button.innerHTML).toBe('Unban');
    expect(button.disabled).toBe(false);
  });
  it('keeps a succeeded action reported as success when the refresh then fails', async () => {
    // The action already landed on the relay before the list is reloaded, so a
    // reload that throws must not be re-reported as the action failing. Without
    // the inner try/catch the rejection falls into the outer catch and the
    // moderator is told the un-ban failed after it succeeded — which invites
    // them to do it a second time.
    const harness = createHarness({
      response: { status: 200, body: { success: true } },
      refreshError: new Error('network blip while reloading the list')
    });

    const button = await runUnban(harness);

    const toast = latestToast(harness);
    expect(toastText(toast)).toBe('Relay ban removed');
    expect(harness.statusLines).toEqual([
      { message: 'Relay ban removed', isError: false }
    ]);
    expect(harness.refreshes).toEqual([{ kind: 'loadVideos' }]);
    expect(button.innerHTML).toBe('Unban');
    expect(button.disabled).toBe(false);
  });
});

describe('dashboard toast action button', () => {
  it('is labelled Undo unless the caller says otherwise', () => {
    const harness = createHarness({ response: { status: 200, body: {} } });
    const undone = [];

    harness.showToast('Moderation applied', () => undone.push('undo'));

    const action = toastAction(latestToast(harness));
    expect(action.textContent).toBe('Undo');
    action.onclick();
    expect(undone).toEqual(['undo']);
  });

  it('takes a different label so a refusal can offer the case instead', () => {
    const harness = createHarness({ response: { status: 200, body: {} } });

    harness.showToast(BLOCK_MESSAGE, () => {}, 10000, 'Open case');

    expect(toastAction(latestToast(harness)).textContent).toBe('Open case');
  });

  it('renders no action button when there is nothing to act on', () => {
    const harness = createHarness({ response: { status: 200, body: {} } });

    harness.showToast('Saved', null, 5000);

    expect(toastAction(latestToast(harness))).toBeNull();
  });
});

// The page's five ways of writing a media decision. Each can be a lift, which
// relay manager refuses while the file's owner has an open age review (#231).
const MARK_SAFE_SRC = extractFunction(dashboardHTML, 'markAsSafe', "action: 'SAFE'");
const LOOKUP_ACTION_SRC = extractFunction(dashboardHTML, 'lookupModerationAction', 'Direct lookup moderation action');
const QUICK_ACTION_SRC = extractFunction(dashboardHTML, 'quickAction', 'Quick action:');
const UNDO_SRC = extractFunction(dashboardHTML, 'undoLastAction', 'Undo: reverted to');
const SAVE_EDITS_SRC = extractFunction(dashboardHTML, 'saveEdits', 'Manual score override by moderator');
const CLOSE_EDIT_SRC = extractFunction(dashboardHTML, 'closeEditModal', 'currentEditingVideo = null');

const mintDecisionFns = new Function('ctx', `
  const {
    document, window, fetch, setTimeout, console, alert, setLookupStatus,
    getVideoBySha, refreshLookupResultIfMatches, removeLookupResultIfMatches,
    isFocusedLookupResult, loadRealStats, showHeaderUndo, clearUndo, applyFilters,
    loadVideos, lookupVideo, allVideos, paginationState
  } = ctx;
  let currentToast = null;
  let lastAction = ctx.lastAction;
  let currentEditingSha256 = ctx.currentEditingSha256;
  let currentEditingVideo = null;
  let currentLookupSha = ctx.currentLookupSha ?? null;
  ${SHOW_TOAST_SRC}
  ${HIDE_TOAST_SRC}
  ${REFUSAL_SRC}
  ${OFFER_CASE_SRC}
  ${MARK_SAFE_SRC}
  ${LOOKUP_ACTION_SRC}
  ${QUICK_ACTION_SRC}
  ${UNDO_SRC}
  ${SAVE_EDITS_SRC}
  ${CLOSE_EDIT_SRC}
  return { markAsSafe, lookupModerationAction, quickAction, undoLastAction, saveEdits };
`);

const SHA = 'ab'.repeat(32);
const LIFT_BLOCK = 'The account that owns this file has an open age review.';

// `focused` puts the decided file in the lookup panel; a function is asked on
// each check, so the panel can move on mid-decision. `lookupSha` is the hash
// the lookup panel shows, if any.
function createDecisionHarness(response, { focused = false, lookupSha = null } = {}) {
  const isFocused = typeof focused === 'function' ? focused : () => focused;
  const harness = createHarness({ response });
  const alerts = [];
  const lookups = [];
  const video = { sha256: SHA, action: 'AGE_RESTRICTED', cdnUrl: 'https://media.test/v.mp4', uploaded_by: PUBKEY };
  const elements = {
    'edit-action': { value: 'SAFE' },
    'edit-reason': { value: '' },
    'filter-action': { value: 'TRIAGE' },
    'edit-modal': { classList: { remove: () => {} } }
  };
  const ctx = {
    document: {
      createElement: createNode,
      body: harness.body,
      querySelectorAll: () => [],
      getElementById: (id) => elements[id] ?? null
    },
    window: { open: (...args) => { harness.opened.push(args); } },
    console: { error: () => {}, log: () => {} },
    setTimeout: (fn, delay) => { harness.timers.push({ fn, delay }); return harness.timers.length; },
    alert: (message) => { alerts.push(message); },
    setLookupStatus: (message, isError = false) => { harness.statusLines.push({ message, isError }); },
    getVideoBySha: () => video,
    refreshLookupResultIfMatches: async () => false,
    removeLookupResultIfMatches: () => {},
    isFocusedLookupResult: (sha256) => isFocused() && sha256 === SHA,
    loadRealStats: () => {},
    showHeaderUndo: () => {},
    clearUndo: () => {},
    applyFilters: () => {},
    loadVideos: async () => {},
    lookupVideo: async (id) => { lookups.push(id); },
    allVideos: [video],
    paginationState: { currentCursor: null },
    lastAction: { sha256: SHA, previousAction: 'SAFE', previousData: video },
    currentEditingSha256: SHA,
    currentLookupSha: lookupSha,
    fetch: async (url, init) => {
      harness.fetchCalls.push({ url, init });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body
      };
    }
  };
  return { ...harness, ...mintDecisionFns(ctx), alerts, lookups };
}

function button() {
  const node = createNode('button');
  node.innerHTML = 'Approve';
  node.closest = () => null;
  return node;
}

const DECISIONS = [
  ['markAsSafe', (h) => h.markAsSafe(SHA, button())],
  ['lookupModerationAction', (h) => h.lookupModerationAction(SHA, 'SAFE', button())],
  ['quickAction', (h) => h.quickAction(SHA, 'SAFE')],
  ['undoLastAction', (h) => h.undoLastAction()],
  ['saveEdits', (h) => h.saveEdits()]
];

describe('dashboard media decisions refused by the lift check', () => {
  it.each(DECISIONS)('%s offers the case when the lift is refused', async (_name, run) => {
    const harness = createDecisionHarness({
      status: 409,
      body: {
        success: false,
        error: LIFT_BLOCK,
        code: 'age_review_active',
        caseId: CASE_ID,
        state: 'open_reported',
        caseUrl: CASE_URL
      }
    });

    await run(harness);

    expect(harness.fetchCalls[0].url).toBe(`/admin/api/moderate/${SHA}`);
    const toast = latestToast(harness);
    expect(toastText(toast)).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
    const action = toastAction(toast);
    expect(action.textContent).toBe('Open case');
    action.onclick();
    expect(harness.opened).toEqual([[CASE_URL, '_blank', 'noopener']]);
    expect(harness.alerts).toEqual([]);
    // The file is not the one in the lookup panel, so its status line is left alone.
    expect(harness.statusLines).toEqual([]);
  });

  it.each(DECISIONS)('%s also says so in the lookup panel when that is the file it shows', async (_name, run) => {
    const harness = createDecisionHarness({
      status: 409,
      body: {
        success: false,
        error: LIFT_BLOCK,
        code: 'age_review_active',
        caseId: CASE_ID,
        state: 'open_reported',
        caseUrl: CASE_URL
      }
    }, { focused: true });

    await run(harness);

    expect(harness.statusLines).toEqual([
      { message: `${LIFT_BLOCK} (case ${CASE_ID})`, isError: true }
    ]);
  });

  it('leaves the lookup panel alone when it moved to another file while the lift was checked', async () => {
    // The panel shows the file when Approve is clicked, and something else by
    // the time relay manager refuses.
    let checks = 0;
    const harness = createDecisionHarness({
      status: 409,
      body: {
        success: false,
        error: LIFT_BLOCK,
        code: 'age_review_active',
        caseId: CASE_ID,
        state: 'open_reported',
        caseUrl: CASE_URL
      }
    }, { focused: () => checks++ === 0 });

    await harness.quickAction(SHA, 'SAFE');

    expect(toastText(latestToast(harness))).toBe(`${LIFT_BLOCK} (case ${CASE_ID})`);
    expect(harness.statusLines).toEqual([]);
  });

  it.each(DECISIONS)('%s says why when a refusal names no case', async (_name, run) => {
    const harness = createDecisionHarness({
      status: 502,
      body: {
        success: false,
        error: 'Could not confirm with relay manager that this file may be made more visible; refusing',
        code: 'lift_check_unavailable'
      }
    });

    await run(harness);

    const said = [
      ...harness.alerts,
      ...harness.statusLines.map((line) => line.message),
      ...harness.toasts.map(toastText)
    ];
    expect(said.some((text) => text?.includes('Could not confirm with relay manager'))).toBe(true);
    expect(harness.opened).toEqual([]);
    expect(harness.toasts.map(toastAction).filter(Boolean)).toEqual([]);
  });
});

// Edit Scores closes its modal, which forgets the hash being edited, before it
// refreshes the lookup panel.
describe('dashboard Edit Scores after a save', () => {
  const SAVED = { status: 200, body: { success: true } };

  it('refreshes the lookup panel when it shows the edited file', async () => {
    const harness = createDecisionHarness(SAVED, { lookupSha: SHA });

    await harness.saveEdits();

    expect(harness.lookups).toEqual([SHA]);
    expect(harness.alerts).toEqual(['Successfully updated scores and action']);
  });

  it('leaves an empty lookup panel alone', async () => {
    const harness = createDecisionHarness(SAVED);

    await harness.saveEdits();

    expect(harness.lookups).toEqual([]);
    expect(harness.alerts).toEqual(['Successfully updated scores and action']);
  });
});

// Rejecting a category can auto-approve the file, which the server only does
// once relay manager's lift check allows it (#231).
const VERIFY_CATEGORY_SRC = extractFunction(dashboardHTML, 'verifyCategory', 'verify-category');
const FORMAT_CATEGORY_SRC = extractFunction(dashboardHTML, 'formatCategoryName', "'nudity': 'Nudity'");

const mintVerifyFns = new Function('ctx', `
  const { document, window, fetch, setTimeout, console, setLookupStatus, getVideoBySha } = ctx;
  let currentToast = null;
  ${SHOW_TOAST_SRC}
  ${HIDE_TOAST_SRC}
  ${OFFER_CASE_SRC}
  ${FORMAT_CATEGORY_SRC}
  ${VERIFY_CATEGORY_SRC}
  return { verifyCategory };
`);

function createVerifyHarness(result) {
  const harness = createHarness({ response: { status: 200, body: result } });
  const video = { sha256: SHA, action: 'AGE_RESTRICTED', categoryVerifications: {} };
  const fns = mintVerifyFns({
    document: { createElement: createNode, body: harness.body, querySelector: () => null },
    window: { open: (...args) => { harness.opened.push(args); } },
    console: { error: () => {}, log: () => {} },
    setTimeout: (fn, delay) => { harness.timers.push({ fn, delay }); return harness.timers.length; },
    setLookupStatus: (message, isError = false) => { harness.statusLines.push({ message, isError }); },
    getVideoBySha: () => video,
    fetch: async () => ({ ok: true, status: 200, json: async () => result })
  });
  return { ...harness, ...fns, video };
}

describe('dashboard category rejection that the lift check keeps from auto-approving', () => {
  const saved = {
    success: true,
    sha256: SHA,
    category: 'nudity',
    status: 'rejected',
    categoryVerifications: { nudity: 'rejected' },
    autoApproved: false
  };

  it('says the file was not approved and offers the case', async () => {
    const harness = createVerifyHarness({
      ...saved,
      autoApproveRefused: {
        status: 409,
        error: LIFT_BLOCK,
        code: 'age_review_active',
        caseId: CASE_ID,
        state: 'open_reported',
        caseUrl: CASE_URL
      }
    });

    await harness.verifyCategory(SHA, 'nudity', 'rejected');

    const toast = latestToast(harness);
    expect(toastText(toast)).toBe(`✗ Rejected: NOT Nudity. Not approved: ${LIFT_BLOCK} (case ${CASE_ID})`);
    toastAction(toast).onclick();
    expect(harness.opened).toEqual([[CASE_URL, '_blank', 'noopener']]);
    expect(harness.video.action).toBe('AGE_RESTRICTED');
  });

  it('says why when the refusal names no case', async () => {
    const harness = createVerifyHarness({
      ...saved,
      autoApproveRefused: {
        status: 502,
        error: 'Could not confirm with relay manager that this file may be made more visible; refusing',
        code: 'lift_check_unavailable'
      }
    });

    await harness.verifyCategory(SHA, 'nudity', 'rejected');

    expect(toastText(latestToast(harness))).toBe(
      '✗ Rejected: NOT Nudity. Not approved: Could not confirm with relay manager that this file may be made more visible; refusing'
    );
    expect(harness.video.action).toBe('AGE_RESTRICTED');
  });
});
