// ── Per-jump notes ──
// A free-text note per jump, persisted synchronously in localStorage as a small
// JSON object keyed by jump name (same side-channel convention as
// flysight_scores / flysight_exit_overrides). The textarea starts at 100 px and
// grows with its content, so a long note never needs an inner scrollbar.
const NOTES_STORE_KEY = 'flysight_notes';
const NOTES_SAVE_DEBOUNCE_MS = 400;
const NOTES_SAVED_HINT_MS = 1600;

let notesSaveTimer = null;
let notesHintTimer = null;

function getJumpNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_STORE_KEY) || '{}'); }
  catch (e) { return {}; }
}

function getJumpNote(name) {
  const v = getJumpNotes()[name];
  return typeof v === 'string' ? v : '';
}

// An empty note is deleted rather than stored, so clearing the box doesn't
// leave a row behind.
function setJumpNote(name, text) {
  if (!name) return;
  const all = getJumpNotes();
  if (text) all[name] = text; else delete all[name];
  try { localStorage.setItem(NOTES_STORE_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
}

function clearJumpNote(name) {
  setJumpNote(name, '');
}

// Grow the box to fit its content. `height: auto` first so it can also shrink
// again after a deletion; the CSS min-height supplies the 100 px floor. The
// border delta is added back, since box-sizing is border-box here while
// scrollHeight covers content + padding only.
//
// Note the textarea deliberately has **no placeholder**: Chromium lays a
// placeholder out inside the element and counts it in scrollHeight, so an empty
// box would be sized to fit the placeholder's wrapped height (measured: 1580 px
// for a one-line placeholder in a narrow column).
function autoGrowNotes(el) {
  if (!el) return;
  // No layout box (a zero-width or hidden ancestor) means the text wraps at
  // roughly one character per line, which would bake in an absurd height. Leave
  // the CSS floor; the width observer below re-measures once there is a width.
  if (!el.clientWidth) return;
  el.style.height = 'auto';
  const borders = el.offsetHeight - el.clientHeight;
  el.style.height = (el.scrollHeight + borders) + 'px';
}

function showNotesSavedHint() {
  const hint = document.getElementById('notesSaved');
  if (!hint) return;
  hint.hidden = false;
  clearTimeout(notesHintTimer);
  notesHintTimer = setTimeout(() => { hint.hidden = true; }, NOTES_SAVED_HINT_MS);
}

// Fill the box for the active jump. Called from renderCurrentJump(), so it also
// runs on a language switch and on a theme change.
function renderJumpNotes() {
  const el = document.getElementById('jumpNotes');
  if (!el) return;
  clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  const hint = document.getElementById('notesSaved');
  if (hint) hint.hidden = true;
  el.value = getJumpNote(state.currentJumpName);
  autoGrowNotes(el);
}

// Listeners are delegated from `document` rather than bound to the textarea, so
// they survive the element being replaced (renderCurrentJump() rewrites the
// whole chart section when a jump has too few rows).
function initJumpNotes() {
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el || el.id !== 'jumpNotes') return;
    autoGrowNotes(el);
    // The jump name is captured per keystroke, so a save still in flight when
    // the user switches jumps lands on the jump the text was typed for.
    const name = state.currentJumpName;
    const text = el.value;
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
      setJumpNote(name, text);
      showNotesSavedHint();
    }, NOTES_SAVE_DEBOUNCE_MS);
  });

  // Don't leave the last few characters unsaved if the user clicks away.
  // `focusout` rather than `blur`, since only the former bubbles to document.
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (!el || el.id !== 'jumpNotes' || !notesSaveTimer) return;
    clearTimeout(notesSaveTimer);
    notesSaveTimer = null;
    setJumpNote(state.currentJumpName, el.value);
    showNotesSavedHint();
  });

  // Re-measure when the column width changes: rewrapping the text into more
  // lines would otherwise be clipped, since overflow-y is hidden. A
  // ResizeObserver rather than a window `resize` listener, because the map /
  // stats splitter and the responsive breakpoints change the panel's width
  // without the window changing size. It watches the *panel*, and only reacts
  // to a width change, so the height autoGrowNotes() sets can't feed back into
  // it.
  const panel = document.querySelector('.notes-panel');
  if (panel && typeof ResizeObserver === 'function') {
    let lastWidth = panel.clientWidth;
    new ResizeObserver(() => {
      if (panel.clientWidth === lastWidth) return;
      lastWidth = panel.clientWidth;
      autoGrowNotes(document.getElementById('jumpNotes'));
    }).observe(panel);
  }
}
