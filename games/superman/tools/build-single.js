#!/usr/bin/env node
/* Bundle the game into ONE self-contained HTML file you can double-click to play.
 *   node tools/build-single.js   ->  dist/superman-over-metropolis.html
 * Inlines style.css and every <script src>, so nothing else needs to sit beside it.
 */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) =>
  `<style>\n${fs.readFileSync(path.join(root, href), 'utf8')}\n</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  // a literal "</script" inside the code would end the tag early
  const code = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script>/* ${src} */\n${code}\n</script>`;
});
const out = path.join(root, 'dist', 'superman-over-metropolis.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
