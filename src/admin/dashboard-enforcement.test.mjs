// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Runs the dashboard's real enforcement handler and toast against stubs
// ABOUTME: so the age-review refusal path is covered by behaviour, not substrings

import { describe, expect, it } from 'vitest';
import dashboardHTML from './dashboard.html';

// dashboard.html has no build step, so the rest of its suite asserts on source
// substrings. That signal is inverted for this path: dropping the structured
// `throw` kills the feature outright and every substring still matches, while
// reformatting a call that behaves identically fails. So pull the functions out
// of the HTML and actually run them.

const PUBKEY = 'b'.repeat(64);
const CASE_ID = '2f3a1c48-9d5e-4b17-9c0a-6e8b1d7f4a20';
const BLOCK_MESSAGE = 'This account is under age review. Restrict or clear it from the Age Review flow.';
const CASE_URL = `https://relay.admin.divine.video/age-review?case=${CASE_ID}`;

// Read one function's source out of the page by name. Braces are only counted
// in code: the scanner walks over strings, template literals (including nested
// `${}` substitutions) and comments, so a brace inside one cannot end the
// function early. That makes extraction survive reformatting of the function it
// pulls, which is the whole point of testing it this way. Regex literals are not
// tracked; neither extracted function contains one.
//
// `mustContain` is the guard on the one failure this cannot otherwise detect.
// The brace scanner below is mode-aware, but the name search on the next line is
// a plain regex over raw source: an earlier textual `function showToast(` in a
// comment or a string hijacks the start index and yields a different function
// that still parses. That failure is silent — no throw, no SyntaxError, just
// tests passing against code the page does not ship. Naming a line that only
// the real body contains turns it into a loud one.
function extractFunction(source, name, mustContain) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) {
    throw new Error(`extractFunction: no declaration of ${name} in dashboard.html`);
  }

  const start = match.index;
  const stack = [];
  let opened = false;

  for (let i = start; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    const mode = stack[stack.length - 1];

    if (mode === "'" || mode === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === mode) { stack.pop(); }
      i += 1;
    } else if (mode === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i += 1; continue; }
      if (ch === '$' && next === '{') { stack.push('${'); i += 2; continue; }
      i += 1;
    } else if (mode === '//') {
      if (ch === '\n') { stack.pop(); }
      i += 1;
    } else if (mode === '/*') {
      if (ch === '*' && next === '/') { stack.pop(); i += 2; continue; }
      i += 1;
    } else if (ch === '/' && next === '/') {
      stack.push('//');
      i += 2;
    } else if (ch === '/' && next === '*') {
      stack.push('/*');
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      stack.push(ch);
      i += 1;
    } else if (ch === '{') {
      stack.push('{');
      opened = true;
      i += 1;
    } else if (ch === '}') {
      stack.pop();
      i += 1;
      if (opened && stack.length === 0) {
        const extracted = source.slice(start, i);
        if (!extracted.includes(mustContain)) {
          throw new Error(
            `extractFunction: extracted a ${name} that does not contain ${JSON.stringify(mustContain)} `
            + '— the name search matched an earlier occurrence, so this is the wrong function'
          );
        }
        return extracted;
      }
    } else {
      i += 1;
    }
  }

  throw new Error(`extractFunction: braces never balanced while reading ${name}`);
}

const SHOW_TOAST_SRC = extractFunction(dashboardHTML, 'showToast', "actionBtn.className = 'toast-action'");
const HIDE_TOAST_SRC = extractFunction(dashboardHTML, 'hideToast', "toast.classList.add('hiding')");
const UPDATE_SRC = extractFunction(dashboardHTML, 'updateUploaderEnforcement', "startsWith('https://')");

// workerd blocks the AsyncFunction constructor, but `new Function` is allowed and
// its generated body may declare an async function the ordinary way. The three
// sources are dropped into one scope so the handler calls the page's real toast.
const mintDashboardFns = new Function('ctx', `
  const {
    document, window, fetch, setTimeout, console,
    setLookupStatus, lookupVideo, loadVideos, currentLookupVideo
  } = ctx;
  let currentToast = null;
  ${SHOW_TOAST_SRC}
  ${HIDE_TOAST_SRC}
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
