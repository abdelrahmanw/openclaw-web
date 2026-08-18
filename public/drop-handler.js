/**
 * drop-handler.js
 *
 * Self-contained drag-and-drop wiring for the chat input.
 *
 * Fixes a duplicate-attachment bug: a drop event on the input area was
 * handled by BOTH the input-area drop handler AND the document-level drop
 * handler (because native `drop` events bubble up to `document`). That
 * produced two attachment entries for every single dropped file.
 *
 * Root-cause fix: the input-area handler calls `e.stopPropagation()` so the
 * handler that owns the event is the only one to process it. The document
 * handler still catches drops that land anywhere else on the page.
 *
 * This module is a plain UMD-style global so it works both in the browser
 * (`app.js` depends on `window.DropHandler`) and under Node for tests
 * (`require('./drop-handler.js')`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DropHandler = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Wire up drag-and-drop for the chat input.
   *
   * @param {object} opts
   * @param {Element} opts.area          The input area element that accepts drops.
   * @param {Document} opts.doc          The document to attach the global handler to.
   * @param {Function} opts.onFiles      Called with a FileList / array of files once per drop.
   * @param {Function} [opts.inputVisible]  Returns true when the input area is displayed.
   * @param {Function} [opts.editActive]    Returns true when an edit container is active.
   * @returns {object} Controller with the bound handlers and a `teardown()`.
   */
  function setupDrop(opts) {
    const area = opts.area;
    const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    const onFiles = opts.onFiles;
    const inputVisible = opts.inputVisible || (function () {
      return area.style.display !== 'none';
    });
    const editActive = opts.editActive || (function () {
      return !!doc.querySelector('.msg-edit-container');
    });

    if (!area) return null;

    function onDragOver(e) {
      e.preventDefault();
      area.style.outline = '2px dashed var(--accent)';
    }
    function onDragLeave() {
      area.style.outline = '';
    }
    function onAreaDrop(e) {
      e.preventDefault();
      // Root-cause of the duplicate-attachment bug: stop the native drop event
      // from bubbling up to the document handler so the files are processed
      // exactly once.
      e.stopPropagation();
      area.style.outline = '';
      onFiles(e.dataTransfer.files);
    }
    function onDocDragOver(e) {
      if (editActive() || inputVisible()) e.preventDefault();
    }
    function onDocDrop(e) {
      if (inputVisible() === false && !editActive()) return; // input hidden & no edit: ignore
      e.preventDefault();
      area.style.outline = '';
      onFiles(e.dataTransfer.files);
    }

    area.addEventListener('dragover', onDragOver);
    area.addEventListener('dragleave', onDragLeave);
    area.addEventListener('drop', onAreaDrop);
    if (doc) {
      doc.addEventListener('dragover', onDocDragOver);
      doc.addEventListener('drop', onDocDrop);
    }

    return {
      onAreaDrop: onAreaDrop,
      onDocDrop: onDocDrop,
      onDocDragOver: onDocDragOver,
      teardown: function () {
        area.removeEventListener('dragover', onDragOver);
        area.removeEventListener('dragleave', onDragLeave);
        area.removeEventListener('drop', onAreaDrop);
        if (doc) {
          doc.removeEventListener('dragover', onDocDragOver);
          doc.removeEventListener('drop', onDocDrop);
        }
      }
    };
  }

  return { setupDrop: setupDrop };
});
