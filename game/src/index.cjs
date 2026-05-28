'use strict';

let _mod;
async function _load() {
  if (!_mod) _mod = await import('./index.js');
  return _mod;
}

// Synchronous access is not possible for ESM from CJS.
// Consumers should use: const { LinxiconEngine, loadEmbeddings } = await require('linxicon-engine')._load()
// Or switch to ESM imports.
module.exports = { _load };
