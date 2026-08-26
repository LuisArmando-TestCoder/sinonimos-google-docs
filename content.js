// Content script for Google Docs.
//
// Google Docs renders the document on canvas and captures typing inside a
// hidden iframe (docs-texteventtarget-iframe). The typed text is NOT readable
// from the main document's DOM, and the caret is not a real DOM node. So:
//
//   * In the typing iframe (run with all_frames + match_about_blank): track the
//     current word from keyboard events, read the caret position from the
//     iframe's own selection, and relay both to the top window via postMessage.
//   * In the top frame: map the iframe-local caret to viewport coordinates,
//     fetch synonyms (via the background worker), show the popup below the
//     caret, and perform best-effort replacement on click.

(function () {
  'use strict';

  var isTop = window === window.top;

  var LETTER_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]$/;
  var MIN_WORD_LENGTH = 2;
  var DEBOUNCE_MS = 300;
  var MAX_SYNONYMS = 30;
  var ORIGIN = 'https://docs.google.com';

  // =========================================================================
  // TOP FRAME: fetch + popup + replacement
  // =========================================================================
  if (isTop) {
    var popup = null;
    var popupList = null;
    var popupTitle = null;
    var defLabel = null;
    var popupDef = null;
    var synLabel = null;
    var currentWord = '';
    var currentDefinition = '';
    var currentAnchor = null;
    var fetchSeq = 0;
    var lastMousePos = { x: 0, y: 0 };

    function ensurePopup() {
      if (popup) return popup;

      popup = document.createElement('div');
      popup.className = 'sindocs-popup';
      popup.setAttribute('role', 'listbox');
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

    function typingIframe() {
      return document.querySelector(
        'iframe.docs-texteventtarget-iframe, ' +
        'iframe.kix-texteventtarget-iframe'
      );
    }

    function resetTypingFrame() {
      var iframe = typingIframe();
      if (iframe && iframe.contentWindow) {
        try {
          iframe.contentWindow.postMessage({ __sindocs: true, type: 'reset' }, ORIGIN);
        } catch (e) { /* ignore */ }
      }
    }

    // Caret coordinates from the child frame are iframe-local. Offset them by
    // the iframe's position in the viewport to get true viewport coordinates.
    function caretToViewport(local) {
      if (!local) return lastMouseRect();
      var iframe = typingIframe();
      if (!iframe) return lastMouseRect();
      var ir = iframe.getBoundingClientRect();
      return {
        left: ir.left + local.left,
        top: ir.top + local.top,
        bottom: ir.top + local.bottom,
        width: local.width || 1,
        height: local.height || 1
      };
    }

    function lastMouseRect() {
      return {
        left: lastMousePos.x,
        top: lastMousePos.y,
        bottom: lastMousePos.y + 20,
        width: 1,
        height: 20
      };
    }

    function getAnchor(relayed) {
      // 1. Docs' own caret element is the most accurate word position.
      var caret = document.querySelector('.kix-cursor-caret-position, .kix-cursor-caret');
      if (caret) {
        var r = caret.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) return r;
      }
      // 2. The typing iframe is positioned over the caret by Docs.
      var iframe = typingIframe();
      if (iframe) {
        var ir = iframe.getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) {
          return { left: ir.left, top: ir.top, bottom: ir.top + ir.height, width: ir.width, height: ir.height };
        }
      }
      // 3. Caret reported from inside the editing iframe.
      if (relayed) return caretToViewport(relayed);
      // 4. Mouse position.
      return lastMouseRect();
    }

    function positionPopup(anchor) {
      ensurePopup();
      var margin = 8;

      popup.style.visibility = 'hidden';
      popup.style.display = 'block';

      var pw = popup.offsetWidth;
      var ph = popup.offsetHeight;
      var vw = window.innerWidth;
      var vh = window.innerHeight;

      var left, top;

      if (anchor) {
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
      ensurePopup();
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
        popup.dataset.firstSyn = '';
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
        chip.setAttribute('role', 'option');
        chip.addEventListener('mousedown', function (e) {
          // Keep focus inside the Docs editing iframe so the caret is preserved.
          e.preventDefault();
          e.stopPropagation();
        });
        chip.addEventListener('click', function (e) {
          e.stopPropagation();
          replaceWord(syn, currentWord);
        });
        popupList.appendChild(chip);
      });

      popup.dataset.firstSyn = shown[0] || '';
      applyDefinition();
      positionPopup(anchor);
    }

    function fetchAndShow(word, anchor) {
      var seq = ++fetchSeq;
      currentAnchor = anchor;
      currentDefinition = '';
      applyDefinition();

      chrome.runtime.sendMessage({ type: 'fetchSynonyms', word }, function (res) {
        if (chrome.runtime.lastError) { /* ignore */ }
        if (seq !== fetchSeq) return;
        if (!currentWord) { hidePopup(); return; }
        var synonyms = (res && Array.isArray(res.synonyms)) ? res.synonyms : [];
        var error = (res && res.error) ? res.error : '';
        renderSynonyms(word, synonyms, anchor, error);
      });

      chrome.runtime.sendMessage({ type: 'fetchDefinition', word }, function (res) {
        if (chrome.runtime.lastError) { /* ignore */ }
        if (seq !== fetchSeq) return;
        currentDefinition = (res && res.definition) ? res.definition : '';
        applyDefinition();
        if (popup && popup.style.display === 'block') {
          positionPopup(currentAnchor);
        }
      });
    }

    function editorSurface() {
      var iframe = typingIframe();
      if (!iframe) return null;
      try {
        var ed = iframe.contentDocument;
        if (!ed) return null;
        var el = ed.activeElement;
        if (!el || el === ed.body) {
          el = ed.querySelector('[contenteditable="true"], [contenteditable], textarea, input');
        }
        if (!el) el = ed.body;
        return { element: el, doc: ed };
      } catch (e) {
        return null;
      }
    }

    function replaceWord(synonym, rawWord) {
      var word = rawWord || currentWord || '';
      if (!synonym) return;

      hidePopup();
      currentWord = '';
      fetchSeq++;

      // Reset the word tracker in the typing iframe so the next keystrokes
      // start a fresh word (not appended to the replaced one).
      resetTypingFrame();

      var surf = editorSurface();
      if (!surf) return;

      try { surf.element.focus(); } catch (e) { /* ignore */ }

      setTimeout(function () {
        try {
          for (var i = 0; i < word.length; i++) {
            surf.element.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'deleteContentBackward',
              bubbles: true,
              cancelable: true,
              composed: true
            }));
          }
          try {
            surf.doc.execCommand('insertText', false, synonym + ' ');
          } catch (e) {
            surf.element.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: synonym + ' ',
              bubbles: true,
              cancelable: true,
              composed: true
            }));
          }
        } catch (e) { /* ignore */ }
      }, 30);
    }

    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN) return;
      var data = e.data;
      if (!data || data.__sindocs !== true) return;

      if (data.type === 'word') {
        var word = data.word;
        if (word && word.length >= MIN_WORD_LENGTH) {
          currentWord = word;
          fetchAndShow(word, getAnchor(data.caret));
        }
      } else if (data.type === 'clear') {
        currentWord = '';
        fetchSeq++;
        hidePopup();
      }
    });

    document.addEventListener('mousemove', function (e) {
      lastMousePos.x = e.clientX;
      lastMousePos.y = e.clientY;
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hidePopup(); return; }
      if (e.key === 'Enter' && popup && popup.style.display === 'block' && popup.dataset.firstSyn) {
        e.preventDefault();
        replaceWord(popup.dataset.firstSyn, currentWord);
      }
    }, true);

    document.addEventListener('mousedown', function (e) {
      if (!popup || !popup.contains(e.target)) {
        // Clicking outside the popup repositions the caret in the document,
        // so invalidate the tracked word. The chip buttons call preventDefault()
        // on mousedown, so selecting a synonym does not land here.
        resetTypingFrame();
        hidePopup();
      }
    });

    window.addEventListener('scroll', function () {
      if (popup && popup.style.display === 'block') {
        hidePopup();
      }
    }, { passive: true });

    window.addEventListener('resize', hidePopup);

    return;
  }

  // =========================================================================
  // CHILD FRAMES: track keystrokes + read caret, relay both to the top frame
  // =========================================================================
  var buffer = '';
  var lastWord = '';
  var debounceTimer = null;

  var NAVIGATION_KEYS = {
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1
  };

  var MODIFIER_KEYS = {
    Control: 1, Shift: 1, Alt: 1, Meta: 1,
    CapsLock: 1, Fn: 1, OS: 1
  };

  function send(message) {
    try {
      window.top.postMessage(Object.assign({ __sindocs: true }, message), ORIGIN);
    } catch (e) { /* ignore */ }
  }

  function clearAll() {
    if (buffer) {
      buffer = '';
      send({ type: 'clear' });
    }
    lastWord = '';
    clearTimeout(debounceTimer);
  }

  // A separator (space, comma, ...) ends the current word but remembers it, so
  // an immediate Backspace "un-does" the separator and resumes the word.
  function commitSeparator() {
    if (buffer) {
      lastWord = buffer;
      buffer = '';
      send({ type: 'clear' });
    }
    clearTimeout(debounceTimer);
  }

  function localCaret() {
    try {
      var sel = document.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        var r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        }
      }
    } catch (e) { /* ignore */ }

    try {
      var el = document.activeElement;
      if (el && el !== document.body) {
        var er = el.getBoundingClientRect();
        if (er.width > 0 && er.height > 0) {
          return { left: er.left, top: er.top, bottom: er.bottom, width: er.width, height: er.height };
        }
      }
    } catch (e) { /* ignore */ }

    return null;
  }

  function notifyWord() {
    if (buffer.length < MIN_WORD_LENGTH) return;
    send({ type: 'word', word: buffer, caret: localCaret() });
  }

  function afterChange() {
    if (buffer.length < MIN_WORD_LENGTH) {
      send({ type: 'clear' });
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(notifyWord, DEBOUNCE_MS);
  }

  window.addEventListener('keydown', function (e) {
    if (MODIFIER_KEYS[e.key]) return;
    // Ignore shortcuts: Ctrl/Cmd/Alt held means the key is a chord (Copy, Paste,
    // Select-all, ...), not a typed character. Without this, pasting via
    // Ctrl+V / Cmd+V would first append the "v" to the tracked word.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Caret movement: the tracked word is no longer the one under the caret.
    if (NAVIGATION_KEYS[e.key]) { clearAll(); return; }

    if (e.key === 'Backspace') {
      if (buffer) {
        buffer = buffer.slice(0, -1);
      } else if (lastWord) {
        // Removing the separator that cut the word off: resume from memory.
        buffer = lastWord;
        lastWord = '';
      }
      afterChange();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
      clearAll();
      return;
    }

    // Single-character key: a letter (incl. accented) or a separator.
    if (e.key && e.key.length === 1) {
      if (LETTER_RE.test(e.key)) {
        lastWord = '';
        buffer += e.key.toLowerCase();
        afterChange();
      } else {
        commitSeparator();
      }
      return;
    }

    // Longer keys ('Dead', 'Process', F-keys) do not reset the buffer.
    // Dead-key intermediates (macOS Option+letter, Windows IME) wait for the
    // composed character, which arrives next as a length-1 key (e.g. "á").
  }, true);

  // Clipboard paste. Pasted text does not arrive as keydown character events,
  // so read it here and treat the trailing word as the word under the caret
  // (the caret lands at the end of the paste).
  window.addEventListener('paste', function (e) {
    var text = '';
    try {
      text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    } catch (err) { /* ignore */ }

    var tokens = text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g) || [];
    if (tokens.length === 0) { clearAll(); return; }

    var last = tokens[tokens.length - 1].toLowerCase();

    // A single pasted word that continues the partial word already typed
    // merges with it ("perso" + paste "na" -> "persona").
    var clean = text.trim();
    var isSingleWord =
      tokens.length === 1 &&
      LETTER_RE.test(clean.charAt(0)) &&
      clean.indexOf(' ') === -1 &&
      clean.indexOf('\n') === -1;

    if (isSingleWord && buffer) {
      last = (buffer + last).toLowerCase();
    }

    lastWord = '';
    buffer = last;
    afterChange();
  }, true);

  // A reset requested by the top frame after a synonym replacement.
  window.addEventListener('message', function (ev) {
    if (ev.origin !== ORIGIN) return;
    if (ev.data && ev.data.__sindocs === true && ev.data.type === 'reset') {
      buffer = '';
      lastWord = '';
      clearTimeout(debounceTimer);
    }
  });

  // Clicking directly inside the editing surface repositions the caret, so it
  // invalidates the tracked word. Momentary focus loss (blur) is deliberately
  // ignored so the user can resume the same word after the frame regains focus;
  // real caret moves that happen outside this iframe are reset by the top frame
  // via a 'reset' message.
  document.addEventListener('mousedown', function () { clearAll(); }, true);
})();
