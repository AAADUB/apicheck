// API Check build: dist/ for Cloudflare (index.html, hashed JS and CSS, self-hosted fonts, _headers, robots.txt).
// Usage: node scripts/build.mjs
import {build} from 'esbuild';
import {readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => readFileSync(join(root, p), 'utf8');
const problems = [];
const js = rd('web/src/main.js');

// 1. the interface is English only, and every error code the Worker can return has a message
const page = rd('web/src/template.html') + js + rd('web/src/api.js') + rd('web/src/styles.css') + rd('shared/providers.js');
const cyr = page.match(/[Ѐ-ӿ][^\n]{0,30}/); if (cyr) problems.push('non-English text in the interface: ' + cyr[0]);
const msgs = js.slice(js.indexOf('const API_ERR'), js.indexOf('const apiMsg'));
const server = ['worker/src/index.ts', 'worker/src/auth.ts', 'worker/src/app.ts'].map(rd).join('\n');
for (const code of new Set([...server.matchAll(/\bbad\('([a-z_]+)'/g)].map(m => m[1]))) if (!new RegExp(`\\b${code}:`).test(msgs) && !['auth', 'csrf', 'json', 'too_large'].includes(code)) problems.push(`no message for error code "${code}"`);
// 2. nothing that looks like a real secret ships
if (/\b(rpa_[A-Za-z0-9]{20,}|secret_[a-z0-9]{20,}_[A-Za-z0-9]{20,}|ucat_[A-Za-z0-9]{20,})\b/.test(page)) problems.push('something that looks like a real key');
if (problems.length) { console.error('Build stopped:\n- ' + problems.join('\n- ')); process.exit(1); }

const css = rd('web/src/styles.css'), tpl = rd('web/src/template.html');
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 10);
const out = join(root, 'dist'); rmSync(out, {recursive: true, force: true}); mkdirSync(join(out, 'assets'), {recursive: true});
const bundle = (await build({entryPoints: [join(root, 'web/src/main.js')], bundle: true, format: 'iife', minify: true, write: false, target: 'es2022', legalComments: 'none'})).outputFiles[0].text;
const jsName = `app.${hash(bundle)}.js`;
let fontCss = '';
for (const [pkg, rename] of [['@fontsource-variable/funnel-display', ["'Funnel Display Variable'", "'Funnel Display'"]], ['@fontsource-variable/funnel-sans', ["'Funnel Sans Variable'", "'Funnel Sans'"]], ['@fontsource-variable/sometype-mono', ["'Sometype Mono Variable'", "'Sometype Mono'"]]]) {
  const dir = join(root, 'node_modules', pkg); if (!existsSync(dir)) { problems.push('font package missing: ' + pkg); continue; }
  const name = pkg.split('/')[1]; let c = readFileSync(join(dir, 'index.css'), 'utf8').replace(/url\(\.\/files\//g, `url(/fonts/${name}/`).replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '');
  c = c.split(rename[0]).join(rename[1]);
  // the interface is English: only the Latin subsets
  c = c.split('/*').filter(b => /^\s*[\w-]*latin[\w-]*\s*\*\//.test(b)).map(b => '/*' + b).join('');
  fontCss += c;
  mkdirSync(join(out, 'fonts', name), {recursive: true});
  for (const m of c.matchAll(/url\(\/fonts\/[\w-]+\/([^)]+)\)/g)) cpSync(join(dir, 'files', m[1]), join(out, 'fonts', name, m[1]));
}
const allCss = fontCss + css, cssName = `app.${hash(allCss)}.css`;
writeFileSync(join(out, 'assets', jsName), bundle); writeFileSync(join(out, 'assets', cssName), allCss);
writeFileSync(join(out, 'index.html'), tpl.replace('<!--CSS-->', () => `<link rel="stylesheet" href="/assets/${cssName}">`).replace('<!--JS-->', () => `<script src="/assets/${jsName}" defer></script>`));
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
writeFileSync(join(out, '_headers'), `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`);
if (problems.length) { console.error('Build stopped:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`dist: ${jsName} ${(bundle.length / 1024).toFixed(0)} KB, ${cssName} ${(allCss.length / 1024).toFixed(0)} KB`);
