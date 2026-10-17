const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function script(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'extension', name), 'utf8');
}

// Extension files are classic scripts in Chrome, so test that same execution mode.
vm.runInThisContext(script('core.js'), { filename: 'core.js' });
vm.runInThisContext(script('extractor.js'), { filename: 'extractor.js' });
module.exports = { core: globalThis.DCArchive, extractor: globalThis.DCExtractor, script };
