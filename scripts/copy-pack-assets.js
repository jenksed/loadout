#!/usr/bin/env node
/**
 * Copies non-TS pack assets (pack.json, capability.json, skill.json, README.md)
 * from src/packs/<id>/ into dist/packs/<id>/ so the built CLI can find them.
 *
 * Also copies the Wave 6R2 qualification runtime bundle from
 * src/core/qualification-runtime/ into dist/core/qualification-runtime/ so the
 * built VERIFY_CHANGE_METHOD can mechanically compute implementation_digest
 * from the runtime bytes (see loadout/src/core/verification.ts).
 *
 * Run automatically after `tsc` via `npm run build`.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function copyDirContents(srcDir, destDir, ignoreCompiled) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    if (ignoreCompiled && (file.endsWith('.js') || file.endsWith('.d.ts') || file.endsWith('.map'))) continue;
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    console.log(`copy-pack-assets: ${path.relative(root, path.join(srcDir, file))} -> ${path.relative(root, path.join(destDir, file))}`);
  }
}

const packsSrc = path.join(root, 'src', 'packs');
const packsDest = path.join(root, 'dist', 'packs');
if (!fs.existsSync(packsSrc)) {
  console.error('copy-pack-assets: no src/packs directory; nothing to do.');
} else {
  fs.mkdirSync(packsDest, { recursive: true });
  for (const entry of fs.readdirSync(packsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    copyDirContents(path.join(packsSrc, entry.name), path.join(packsDest, entry.name), true);
  }
}

// Wave 6R2 qualification runtime bundle: mechanical-binding source artifacts.
// These files are intentionally excluded from `tsc` (see tsconfig.build.json)
// because they are not compiled into the Loadout bundle — they are hashed at
// load time to derive VERIFY_CHANGE_METHOD.implementation_digest.
const runtimeSrc = path.join(root, 'src', 'core', 'qualification-runtime');
const runtimeDest = path.join(root, 'dist', 'core', 'qualification-runtime');
copyDirContents(runtimeSrc, runtimeDest, false);
