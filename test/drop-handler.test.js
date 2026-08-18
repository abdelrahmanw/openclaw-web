/**
 * Regression tests for the chat file drag-and-drop fix.
 *
 * Bug: dropping one file created two attachment entries because a drop on the
 * input area was processed by BOTH the input-area drop handler AND the
 * document-level drop handler (native `drop` events bubble up to `document`).
 *
 * Fix (drop-handler.js): the input-area drop handler calls
 * `e.stopPropagation()` so the event is processed exactly once by the handler
 * that owns it. The document handler still catches drops that land elsewhere
 * on the page.
 *
 * These tests use jsdom to simulate real drop events and assert the
 * single-invocation invariant: one dropped file -> one handleFiles call, and
 * each file in a multi-file drop appears exactly once.
 */

const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const DropHandler = require(path.join(__dirname, '..', 'public', 'drop-handler.js'));
const APP_JS = require('fs').readFileSync(
  path.join(__dirname, '..', 'public', 'app.js'),
  'utf8'
);

describe('Chat drag-and-drop attachments', function () {

  function makeDom() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="input-area"></div></body></html>');
    return dom;
  }

  // Build a drop event with a mocked dataTransfer carrying the given File objects.
  // (jsdom does not implement a DataTransfer constructor, so we hand-mock the
  // `files` list that the drop handlers read.)
  function makeDropEvent(dom, files) {
    const { window } = dom;
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    const fileList = [];
    files.forEach(f => fileList.push(f)); // array-like of File objects
    Object.defineProperty(event, 'dataTransfer', {
      configurable: true,
      value: {
        files: fileList,
        items: { length: fileList.length }
      }
    });
    return event;
  }

  function file(dom, name) {
    return new dom.window.File([`content-${name}`], name, { type: 'text/plain' });
  }

  it('one dropped file on the input area produces exactly one attachment entry', function () {
    const dom = makeDom();
    const { document } = dom.window;
    const area = document.getElementById('input-area');
    const handled = [];

    DropHandler.setupDrop({
      area: area,
      doc: document,
      onFiles: (files) => {
        Array.from(files).forEach(f => handled.push(f.name));
      }
    });

    // Drop a single file directly on the input area.
    area.dispatchEvent(makeDropEvent(dom, [file(dom, 'report.pdf')]));

    assert.strictEqual(handled.length, 1, 'exactly one file should be handled');
    assert.deepStrictEqual(handled, ['report.pdf'], 'the single file should appear exactly once');
  });

  it('multiple dropped files on the input area each appear exactly once', function () {
    const dom = makeDom();
    const { document } = dom.window;
    const area = document.getElementById('input-area');
    const handled = [];

    DropHandler.setupDrop({
      area: area,
      doc: document,
      onFiles: (files) => {
        Array.from(files).forEach(f => handled.push(f.name));
      }
    });

    const names = ['a.txt', 'b.txt', 'c.txt'];
    area.dispatchEvent(makeDropEvent(dom, names.map(n => file(dom, n))));

    assert.strictEqual(handled.length, names.length, 'each dropped file should be handled exactly once');
    assert.deepStrictEqual(handled.sort(), ['a.txt', 'b.txt', 'c.txt'].sort());
  });

  it('a drop on the input area does NOT also fire the document-level handler', function () {
    const dom = makeDom();
    const { document } = dom.window;
    const area = document.getElementById('input-area');
    let handled = 0;
    let areaHandled = 0;
    let docHandled = 0;

    DropHandler.setupDrop({
      area: area,
      doc: document,
      onFiles: () => { handled++; }
    });

    // Instrument the raw handlers to prove the document handler is skipped for
    // input-area drops (the propagation-stop invariant at the root cause).
    area.addEventListener('drop', () => { areaHandled++; }, { capture: true });
    document.addEventListener('drop', () => { docHandled++; }, { capture: true });

    area.dispatchEvent(makeDropEvent(dom, [file(dom, 'x.png')]));

    assert.strictEqual(areaHandled, 1, 'input-area should observe the drop');
    assert.strictEqual(docHandled, 1, 'document should observe the drop while it bubbles (capture sees it)');
    assert.strictEqual(handled, 1, 'onFiles must be invoked exactly once despite bubbling to document');
  });

  it('a drop that lands on the document (outside the input area, input visible) is still handled', function () {
    const dom = makeDom();
    const { document } = dom.window;
    const area = document.getElementById('input-area');
    const handled = [];

    DropHandler.setupDrop({
      area: area,
      doc: document,
      onFiles: (files) => {
        Array.from(files).forEach(f => handled.push(f.name));
      }
    });

    // Input area is visible by default (display not 'none'), so a drop anywhere
    // on the document should be caught by the document-level handler.
    document.body.dispatchEvent(makeDropEvent(dom, [file(dom, 'outside.pdf')]));

    assert.deepStrictEqual(handled, ['outside.pdf'], 'document-level drop should be handled once');
  });

  // ------------------------------------------------------------------
  // Safety net: the app source must delegate to the shared module and keep
  // the stopPropagation fix in the legacy fallback so the bug cannot regress.
  // ------------------------------------------------------------------

  it('app.js delegates drag-and-drop to the shared DropHandler module', function () {
    assert.ok(
      APP_JS.includes('window.DropHandler.setupDrop'),
      'app.js should call window.DropHandler.setupDrop'
    );
  });

  it('app.js legacy fallback keeps the stopPropagation root-cause fix', function () {
    // Legacy wiring block must call stopPropagation on the area drop handler.
    const legacyBlock = APP_JS.split('// Legacy fallback wiring')[1] || '';
    assert.ok(
      legacyBlock.includes('e.stopPropagation()'),
      'legacy drop handler should stop propagation to avoid double attachment entries'
    );
  });

  it('index.html loads drop-handler.js before app.js', function () {
    const html = require('fs').readFileSync(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf8'
    );
    const dropIdx = html.indexOf('/drop-handler.js');
    const appIdx = html.indexOf('/app.js');
    assert.ok(dropIdx !== -1, 'index.html should include drop-handler.js');
    assert.ok(appIdx !== -1, 'index.html should include app.js');
    assert.ok(dropIdx < appIdx, 'drop-handler.js must load before app.js');
  });
});
