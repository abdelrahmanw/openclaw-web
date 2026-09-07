const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

describe('Facts Tools menu item', function () {
  const document = new JSDOM(INDEX_HTML).window.document;
  const toolsMenu = document.getElementById('tools-menu-dropdown');

  it('is present once in the shared desktop/mobile Tools menu', function () {
    assert.ok(toolsMenu, 'shared responsive Tools menu must exist');
    const factsItems = toolsMenu.querySelectorAll('#tools-facts-btn');
    assert.strictEqual(factsItems.length, 1, 'Facts item must appear exactly once');
    assert.strictEqual(factsItems[0].textContent.trim(), 'Facts');
  });

  it('closes the Tools menu and navigates to /facts', function () {
    const factsItem = toolsMenu.querySelector('#tools-facts-btn');
    assert.strictEqual(
      factsItem.getAttribute('onclick'),
      "closeToolsMenu(); window.location.href='/facts'"
    );
  });
});
