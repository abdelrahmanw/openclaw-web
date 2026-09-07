const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FACTS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'facts.html'),
  'utf8'
);

function renderFacts(theme) {
  return new JSDOM(FACTS_HTML, {
    runScripts: 'dangerously',
    beforeParse(window) {
      if (theme !== undefined) window.localStorage.setItem('openclaw-theme', theme);
      window.fetch = () => new Promise(() => {});
    },
    url: 'https://example.test/facts',
  });
}

describe('Facts theme sync', function () {
  it('applies the persisted light theme before the stylesheet', function () {
    const scriptIndex = FACTS_HTML.indexOf('(function syncFactsTheme()');
    const styleIndex = FACTS_HTML.indexOf('<style>');
    assert.ok(scriptIndex > -1 && scriptIndex < styleIndex);

    const dom = renderFacts('light');
    assert.ok(dom.window.document.documentElement.classList.contains('light'));
    dom.window.close();
  });

  it('defaults to dark for dark or missing persisted values', function () {
    for (const theme of ['dark', undefined]) {
      const dom = renderFacts(theme);
      assert.ok(!dom.window.document.documentElement.classList.contains('light'));
      dom.window.close();
    }
  });

  it('tracks openclaw-theme changes made in another tab', function () {
    const dom = renderFacts('dark');
    const root = dom.window.document.documentElement;

    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {
      key: 'openclaw-theme',
      newValue: 'light',
    }));
    assert.ok(root.classList.contains('light'));

    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {
      key: 'openclaw-theme',
      newValue: 'dark',
    }));
    assert.ok(!root.classList.contains('light'));
    dom.window.close();
  });
});
