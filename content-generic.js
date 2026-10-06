// Generic content script: runs on any website (top frame only).
//
// Unlike the Google Docs version (which tracks keystrokes inside a hidden
// iframe), here we simply watch the user's text selection. When the user
// selects a single word (double-click or drag) — whether in normal document
// text, a contenteditable, an <input>, or a <textarea> — we wait for the mouse
// to stop (same 300ms debounce used in Docs) and then look it up via
// WordReference, showing the popup right below the selection.

(function () {
  'use strict';

  if (window !== window.top) return;

  var MIN_WORD_LENGTH = 2;
  var DEBOUNCE_MS = 300;
  var MAX_SYNONYMS = 30;
  var HAS_LETTER_RE = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
  var WHITESPACE_RE = /\s/;

  var popup = null;
  var popupTitle = null;
  var defLabel = null;
  var popupDef = null;
  var synLabel = null;
  var popupList = null;
  var currentWord = '';
  var currentDefinition = '';
  var currentAnchor = null;
  var fetchSeq = 0;
  var debounceTimer = null;

  function ensurePopup() {
    if (popup) return popup;
    if (!document.body) return null;

    popup = document.createElement('div');
    popup.className = 'sindocs-popup';
    popup.setAttribute('role', 'dialog');
    popup.style.display = 'none';

    popupTitle = document.createElement('div');
    popupTitle.className = 'sindocs-title';

    defLabel = document.createElement('div');
    defLabel.className = 'sindocs-def-label';
    defLabel.textContent = 'Definición';

    popupDef = document.createElement('div');
    popupDef.className = 'sindocs-def';

    synLabel = document.createElement('div');
    synLabel.className = 'sindocs-syn-label';
    synLabel.textContent = 'Sinónimos';

    popupList = document.createElement('div');
    popupList.className = 'sindocs-list';

    popup.appendChild(popupTitle);
    popup.appendChild(defLabel);
    popup.appendChild(popupDef);
    popup.appendChild(synLabel);
    popup.appendChild(popupList);
    document.body.appendChild(popup);

    return popup;
  }

  function positionPopup(anchor) {
    if (!ensurePopup()) return;
    var margin = 8;

    popup.style.visibility = 'hidden';
    popup.style.display = 'block';

    var pw = popup.offsetWidth;
    var ph = popup.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var left, top;

    if (anchor && (anchor.width > 0 || anchor.height > 0)) {
      left = anchor.left;
      top = anchor.bottom + margin;

      if (top + ph > vh - margin) top = anchor.top - ph - margin;
      if (top < margin) top = margin;

      if (left + pw > vw - margin) left = Math.max(margin, vw - pw - margin);
      if (left < margin) left = margin;

      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      popup.style.transform = 'none';
    } else {
      popup.style.left = '50%';
      popup.style.top = Math.max(margin, vh - ph - 16) + 'px';
      popup.style.transform = 'translateX(-50%)';
    }

    popup.style.visibility = 'visible';
  }

  function hidePopup() {
    if (popup) {
      popup.style.display = 'none';
      popup.style.visibility = 'hidden';
    }
  }

  function applyDefinition() {
    if (!popupDef) return;
    if (currentDefinition) {
      defLabel.style.display = 'block';
      popupDef.textContent = currentDefinition;
      popupDef.style.display = 'block';
    } else {
      defLabel.style.display = 'none';
      popupDef.textContent = '';
      popupDef.style.display = 'none';
    }
  }

  function renderSynonyms(word, synonyms, anchor, error) {
    if (!ensurePopup()) return;
    popupTitle.textContent = word;
    popupList.innerHTML = '';

    if (!synonyms || synonyms.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'sindocs-empty';
      if (error) {
        empty.textContent = 'Error: ' + error;
      } else {
        empty.textContent = 'No se encontraron sinónimos';
      }
      popupList.appendChild(empty);
      applyDefinition();
      positionPopup(anchor);
      return;
    }

    var shown = synonyms.slice(0, MAX_SYNONYMS);
    shown.forEach(function (syn) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sindocs-chip';
      chip.textContent = syn;
      // Read-only on generic pages: we only show definition + synonyms.
      // preventDefault also keeps the active selection from collapsing.
      chip.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      popupList.appendChild(chip);
    });

    applyDefinition();
    positionPopup(anchor);
  }

  function fetchAndShow(word, anchor) {
    var seq = ++fetchSeq;
    currentAnchor = anchor;
    currentDefinition = '';
    applyDefinition();

    chrome.runtime.sendMessage({ type: 'fetchSynonyms', word: word }, function (res) {
      if (chrome.runtime.lastError) { /* ignore */ }
      if (seq !== fetchSeq) return;
      if (!currentWord) { hidePopup(); return; }
      var synonyms = (res && Array.isArray(res.synonyms)) ? res.synonyms : [];
      var error = (res && res.error) ? res.error : '';
      renderSynonyms(word, synonyms, anchor, error);
    });

    chrome.runtime.sendMessage({ type: 'fetchDefinition', word: word }, function (res) {
      if (chrome.runtime.lastError) { /* ignore */ }
      if (seq !== fetchSeq) return;
      currentDefinition = (res && res.definition) ? res.definition : '';
      applyDefinition();
      if (popup && popup.style.display === 'block') {
        positionPopup(currentAnchor);
      }
    });
  }

  // Normalize a candidate string into a single lookup word, or null.
  // The guard: after trimming, if it contains whitespace it is more than one
  // word (a phrase), so it is ignored. It must also contain at least one letter.
  function normalize(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return null;
    if (WHITESPACE_RE.test(text)) return null;      // more than one word
    if (!HAS_LETTER_RE.test(text)) return null;     // not word-like (e.g. "...", "123")
    if (text.length < MIN_WORD_LENGTH) return null; // too short
    return text.toLowerCase();
  }

  // Selection inside an <input> / <textarea> is NOT exposed by
  // window.getSelection(); it lives in the form control's selectionStart/End.
  function formControlSelection() {
    var el = document.activeElement;
    if (!el) return null;
    var tag = (el.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
    try {
      if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' &&
          el.selectionStart !== el.selectionEnd) {
        return normalize(el.value.substring(el.selectionStart, el.selectionEnd));
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Returns the trimmed selection, but only when it is a single word.
  function readSelectedWord() {
    // 1) Selection inside a form control.
    var fromForm = formControlSelection();
    if (fromForm) return fromForm;

    // 2) Regular document / contenteditable selection.
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      var word = normalize(sel.toString());
      if (word) return word;
    }

    return null;
  }

  function selectionAnchor() {
    // Form-control selection: anchor the popup to the control's box.
    var el = document.activeElement;
    if (el) {
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        try {
          if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' &&
              el.selectionStart !== el.selectionEnd) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
              return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            }
          }
        } catch (e) { /* ignore */ }
      }
    }

    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    try {
      var rr = sel.getRangeAt(0).getBoundingClientRect();
      if (rr && (rr.width > 0 || rr.height > 0)) {
        return { left: rr.left, top: rr.top, bottom: rr.bottom, width: rr.width, height: rr.height };
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  function doLookup() {
    var word = readSelectedWord();
    if (word) {
      currentWord = word;
      fetchAndShow(word, selectionAnchor());
    } else {
      currentWord = '';
      fetchSeq++;
      hidePopup();
    }
  }

  // Debounce until the mouse has stopped moving / the selection has settled,
  // mirroring the Docs behaviour of waiting for input to settle.
  function scheduleLookup() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doLookup, DEBOUNCE_MS);
  }

  document.addEventListener('selectionchange', scheduleLookup);
  document.addEventListener('select', scheduleLookup, true);
  document.addEventListener('mouseup', scheduleLookup);
  document.addEventListener('dblclick', scheduleLookup);

  // "Wait until the mouse has stopped": any mouse movement restarts the wait.
  document.addEventListener('mousemove', scheduleLookup, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hidePopup();
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (!popup || !popup.contains(e.target)) {
      hidePopup();
    }
  });

  window.addEventListener('scroll', function () {
    hidePopup();
  }, { passive: true });

  window.addEventListener('resize', hidePopup);
})();