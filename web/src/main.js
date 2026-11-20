/* API Check interface. Plain JavaScript, no framework: the screens are strings, events are delegated, the server is web/src/api.js. */
import {Api} from './api.js';
import {PROVIDERS, DEV_PROVIDER, LIMITS, PARAMS, LEVEL_NAME, levelRank, EVERY_MAX} from '../../shared/providers.js';

const api = new Api();
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('apicheck.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('apicheck.' + k, JSON.stringify(v)); } catch { /* storage may be off */ } }
};
const ROUTES = ['watches', 'watch', 'new', 'edit', 'market', 'machines', 'activity', 'keys', 'users', 'settings'];
const S = {me: null, auth: {setup: false}, link: null, linkBad: false, route: 'watches', id: null, D: {}, live: {}, theme: store.get('theme', 'auto'), ed: null, mk: {key: null, params: {}, data: null, all: false, err: null, loading: false}, af: 'all', painted: ''};
const PROV = () => (S.me && S.me.dev ? {...PROVIDERS, ...DEV_PROVIDER} : PROVIDERS);
const pv = id => PROV()[id] || {name: id, launch: [], keyFields: [], notes: [], signal: 'level', regionsLabel: 'Regions'};
const isAdmin = () => !!S.me && S.me.role === 'admin';
const s = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + 's'}`;

/* ---------- words ---------- */
const NAV = {watches: 'Watches', market: 'Availability', machines: 'Machines', activity: 'Activity', keys: 'Keys', users: 'Users', settings: 'Settings'};
const API_ERR = {
  server: 'The server returned an error. Try again.', offline: 'No connection to the server. Check your network and retry.', auth: 'Your session has ended. Sign in again.',
  credentials: 'Wrong email or password.', email_taken: 'That email is already in use.', email: 'Check the email address.', password: 'Use a password of 8 characters or more.',
  current_password: 'The current password did not match.', slow_down: 'Too many attempts. Wait a minute and try again.', not_found: 'Not found.', forbidden: 'Only an administrator can do this.',
  setup_token: 'The setup code did not match.', setup_done: 'This workspace is already set up.', invite: 'The link has been used already or has expired.', self: 'You cannot do this to your own account.',
  user_limit: 'The user limit has been reached.', blocked: 'This user is blocked. Unblock them first.', role: 'Choose a role: member or administrator.', empty: 'There is nothing to change.',
  provider: 'Choose a provider.', key_format: 'That does not look like a key for this provider. Paste it in full, without spaces.', key_rejected: 'The provider refused the key.',
  provider_busy: 'The provider asks to slow down. Wait a few seconds and try again.', provider_refused: 'The provider refused the request.', provider_down: 'The provider is not answering right now. Try again in a minute.',
  key_limit: 'You already have 50 keys. Delete one to add another.', label: 'Give the key a name of up to 60 characters.', configs: 'Choose at least one configuration (up to 20).',
  regions: 'Choose at least one region.', mode: 'Choose what happens when capacity is found.', notify_unsupported: 'This provider can only be watched by trying to launch.', params: 'Check the settings above the list.',
  launch_field: 'Check the launch settings.', every: 'Choose a check interval within the provider’s limits.', max_launch: 'Start from 1 to 10 machines.', renotify: 'Choose a quiet time from 1 minute to 24 hours.',
  max_price: 'The price cap must be above zero.', dates: 'Check the start and end: the end must be in the future and after the start.', name: 'Give the watch a name.', key_broken: 'The key of this watch was refused by the provider. Replace it on the Keys page first.',
  watch_limit: 'You already have 60 watches. Delete one to add another.', state: 'That is not a state a watch can have.', launch_done: 'This watch has started all the machines it was allowed to. Raise the number in its settings first.', launch_unknown: 'A launch of this watch was never confirmed. Check the provider console; if no machine was started, delete that launch on the Machines page, then resume.', group: 'A group name uses letters, digits, spaces, dots, dashes and underscores.',
  not_running: 'The watch is paused or finished. Resume it first.', no_machine: 'This launch has no machine to read.', mail_off: 'Email is not set up on this server yet.', send_failed: 'The message could not be sent.'
};
const apiMsg = e => (API_ERR[e && e.code] || API_ERR.server) + (e && e.detail ? ' ' + e.detail : '');

/* ---------- numbers and times ---------- */
const nf = (d = 0) => new Intl.NumberFormat('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});
const money = (v, cur = 'USD') => v == null ? '' : (cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur + ' ') + nf(v < 10 ? 2 : v < 100 ? 2 : 0).format(v);
const perHour = (v, cur) => (v == null ? '' : money(v, cur) + '/h');
const tf = o => new Intl.DateTimeFormat('en-GB', o);
function when(ms) {
  if (!ms) return 'never';
  const d = new Date(ms), today = d.toDateString() === new Date().toDateString();
  return (today ? 'today' : tf({day: 'numeric', month: 'short'}).format(d)) + ', ' + tf({hour: '2-digit', minute: '2-digit', hour12: false}).format(d);
}
const timeOnly = ms => tf({hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(ms));
function ago(ms) {
  if (!ms) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 5) return 'just now'; if (sec < 60) return sec + ' s ago'; if (sec < 3600) return Math.floor(sec / 60) + ' min ago';
  if (sec < 86400) return Math.floor(sec / 3600) + ' h ' + Math.floor(sec % 3600 / 60) + ' min ago';
  return when(ms);
}
function dur(sec) {
  if (sec < 60) return s(sec, 'second'); if (sec < 3600) { const m = Math.floor(sec / 60), r = sec % 60; return s(m, 'minute') + (r ? ' ' + r + ' s' : ''); }
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return s(h, 'hour') + (m ? ' ' + m + ' min' : '');
}
const shortDur = sec => (sec < 60 ? sec + ' s' : sec < 3600 ? Math.round(sec / 60) + ' min' : Math.round(sec / 360) / 10 + ' h');

/* ---------- small pieces ---------- */
const ICON = {
  watches: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12 18 6"/>', market: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  machines: '<rect x="3.5" y="4" width="17" height="6.5" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5"/><path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6"/>', activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2"/>', users: '<circle cx="9" cy="8.5" r="3"/><path d="M3 19.5c.5-3 2.8-4.7 6-4.7s5.5 1.7 6 4.7"/><path d="M15.5 5.8a3 3 0 0 1 0 5.4M17.5 15c2 .6 3.2 2.1 3.5 4.5"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>', plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>', pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>', sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 0 0-16z" fill="currentColor" stroke="none"/>', out: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>', edit: '<path d="M4 20h4l11-11-4-4L4 16z"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>', bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>'
};
const ico = (k, n = 18) => `<svg class="ico" viewBox="0 0 24 24" width="${n}" height="${n}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
/* the mark: a signal line, and the green dot it is waiting for */
const brandMark = (n = 26) => `<svg class="mark" viewBox="0 0 28 28" width="${n}" height="${n}" aria-hidden="true"><rect width="28" height="28" rx="7" fill="var(--ink)"/><path d="M5 18h4l2.5-7 3 11 2.5-8H23" fill="none" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21.5" cy="9" r="2.4" fill="var(--go-on-ink)"/></svg>`;
const brand = () => `<span class="brand">${brandMark()}<span>API Check</span></span>`;
const pdot = p => `<span class="pv-dot pv-${esc(p)}" aria-hidden="true">${esc(pv(p).short || '?')}</span>`;
const st = (text, tone) => `<span class="st st-${tone}"><i aria-hidden="true"></i>${esc(text)}</span>`;
const lv = (level, note) => { const k = level || 'unk'; return `<span class="lv lv-${k}" title="${esc(note || '')}"><span class="bars" aria-hidden="true"><b></b><b></b><b></b></span>${esc(LEVEL_NAME[level] || 'Unknown')}</span>`; };
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 5600); }
const ring = () => `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="r-bg" cx="18" cy="18" r="15"/><circle class="r-fg" cx="18" cy="18" r="15" pathLength="100"/></svg>`;
const seg = (act, cur, opts, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${opts.map(([v, t]) => `<button type="button" data-act="${act}" data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}">${esc(t)}</button>`).join('')}</div>`;
function watchState(w) {
  if (w.state === 'paused') return st('Paused', 'mute');
  if (w.state === 'done') return st('Finished', 'done');
  if (w.state === 'stopped') return st('Stopped', 'crit');
  const l = S.live[w.id], found = l ? l.found : (w.status && w.status.found) || [], err = l ? l.err : w.error;
  if (w.startsAt && w.startsAt > Date.now()) return st('Starts ' + when(w.startsAt), 'mute');
  if (err) return st('Cannot check', 'warn');
  if (found && found.length) return st(w.mode === 'launch' ? 'Found, launching' : 'Available now', 'go');
  return st('Watching', 'live');
}
const cfgName = (w, id) => (w.spec.names && w.spec.names[id]) || id;
const whatLine = w => w.spec.configs.map(c => cfgName(w, c)).join(', ');
const whereLine = w => (w.spec.regions && w.spec.regions.length ? w.spec.regions.join(', ') : 'any ' + pv(w.provider).regionsLabel.toLowerCase().replace(/s$/, ''));
const foundChips = (w, found) => `<span class="found">${found.slice(0, 6).map(o => `<span class="tag go">${esc(cfgName(w, o.config))} · ${esc(o.region)}</span>`).join('')}${found.length > 6 ? `<span class="tag">+${found.length - 6}</span>` : ''}</span>`;

/* ---------- frame ---------- */
function shell(title, body, o = {}) {
  const cur = ['watch', 'new', 'edit'].includes(S.route) ? 'watches' : S.route, c = (S.me && S.me.counts) || {};
  const nav = ['watches', 'market', 'machines', 'activity', 'keys'].concat(isAdmin() ? ['users'] : []).concat(['settings']);
  const n = {watches: c.active || '', machines: c.machines || '', keys: c.keys || ''};
  const link = (r, cls = '') => `<a href="#${r}" class="${cls}"${cur === r ? ' aria-current="page"' : ''}>${ico(r)}<span>${NAV[r]}</span>${n[r] ? `<span class="n">${n[r]}</span>` : ''}</a>`;
  return `<button type="button" class="skip" data-act="skip">Skip to content</button><div class="app">
    <aside class="rail"><a href="#watches" class="brand-a" aria-label="API Check, watches">${brand()}</a>
      <nav class="nav" aria-label="Sections">${nav.slice(0, 5).map(r => link(r)).join('')}<div class="nav-sep" role="presentation"></div>${nav.slice(5).map(r => link(r)).join('')}</nav>
      <div class="rail-foot"><span class="who" title="${esc(S.me.email)}">${esc(S.me.email)}</span><span class="role">${isAdmin() ? 'Administrator' : 'Member'}</span>
        <div class="rail-acts"><button type="button" class="ib" data-act="theme" aria-label="Switch theme" title="Theme: ${S.theme}">${ico('theme', 17)}</button><button type="button" class="ib" data-act="logout" aria-label="Sign out" title="Sign out">${ico('out', 17)}</button></div></div></aside>
    <div class="page"><header class="bar"><div class="bar-l">${o.crumb || ''}<h1>${title}</h1>${o.tag || ''}</div><div class="bar-r">${o.right || ''}</div></header>
      <main id="main" tabindex="-1">${body}</main>
      <footer class="foot"><span>API Check watches GPU clouds through their own APIs. Capacity can disappear within seconds of being seen.</span><span>${S.me.mailReady ? 'Email to ' + esc(S.me.notifyEmail) : 'Email not set up'}</span></footer></div>
    <nav class="tabbar" aria-label="Sections">${['watches', 'market', 'machines', 'activity', 'settings'].map(r => link(r)).join('')}</nav></div>`;
}

/* ---------- signed out ---------- */
function vLogin() {
  const lanes = [['8x H100 · us-east-1', [[4, 9], [31, 33], [71, 80]]], ['8x H100 · fi-hel2', [[18, 21], [56, 58]]], ['8x H200 · eu-north1', [[40, 52], [88, 92]]], ['8x B200 · US-KS-2', [[63, 64]]]];
  const demo = lanes.map(([n, w], li) => `<div class="lane"><span>${esc(n)}</span><div class="track" role="img" aria-label="${esc(n)}: free ${w.length} times in a day">${w.map(([a, b], i) => `<i style="left:${a}%;width:${Math.max(.8, b - a)}%;--i:${li * 3 + i}"></i>`).join('')}</div></div>`).join('');
  return `<button type="button" class="skip" data-act="skip">Skip to sign-in</button><div class="login"><section class="lg-a"><header>${brand()}</header>
    <div class="lg-pitch"><h1>Catch the GPU the moment it frees up.</h1><p>API Check asks GPU clouds through their own APIs, every few seconds, whether the machine you need can be started. When it can, you get an email, or the machine is started for you before someone else takes it.</p></div>
    <figure class="lg-demo"><div class="strip">${demo}</div><figcaption><span>A day of availability, as a watch sees it (sample)</span><span>Lambda · UpCloud · Nebius · RunPod</span></figcaption></figure></section>
    <section class="lg-b"><p class="lg-brand">${brand()}</p>${S.link ? fLink() : S.linkBad ? fLinkBad() : S.auth.setup ? fSetup() : fLogin()}</section></div>`;
}
const twoPass = () => `<label class="fld"><span>Password</span><input type="password" id="lgPass" autocomplete="new-password" minlength="8" required aria-describedby="lgPassH"><small id="lgPassH">8 characters or more.</small></label>
  <label class="fld"><span>Repeat the password</span><input type="password" id="lgPass2" autocomplete="new-password" minlength="8" required></label>`;
const fLogin = () => `<form class="form card" id="loginForm" data-form="login" novalidate><h2>Sign in</h2>
  <label class="fld"><span>Email</span><input type="email" id="lgEmail" autocomplete="email" required></label>
  <label class="fld"><span>Password</span><input type="password" id="lgPass" autocomplete="current-password" minlength="8" required></label>
  <p class="err" role="alert" hidden></p><button class="btn full" type="submit">Sign in</button><p class="hint">This workspace is closed. Access is given by its administrator.</p></form>`;
const fSetup = () => `<form class="form card" id="loginForm" data-form="setup" novalidate><h2>First run</h2><p class="hint">There are no users yet. Create the administrator, who then gives access to everyone else.</p>
  <label class="fld"><span>Setup code</span><input type="text" class="secret" id="suCode" autocomplete="off" spellcheck="false" required aria-describedby="suCodeH"><small id="suCodeH">The value of the SETUP_TOKEN secret.</small></label>
  <label class="fld"><span>Email</span><input type="email" id="lgEmail" autocomplete="username" required></label>${twoPass()}<p class="err" role="alert" hidden></p><button class="btn full" type="submit">Create administrator</button></form>`;
const fLink = () => `<form class="form card" id="loginForm" data-form="link" novalidate><h2>${S.link.kind === 'reset' ? 'Set a new password' : 'Set your password'}</h2>
  <label class="fld"><span>Email</span><input type="email" id="lgEmail" autocomplete="username" value="${esc(S.link.email)}" readonly></label>${twoPass()}<p class="err" role="alert" hidden></p><button class="btn full" type="submit">Save and sign in</button></form>`;
const fLinkBad = () => `<div class="form card" id="loginForm"><h2>This link does not work</h2><p>It has been used already or has expired. Ask the administrator for a new one.</p><button class="btn full" type="button" data-act="toLogin">Back to sign-in</button></div>`;

/* ---------- watches ---------- */
function vWatches() {
  const l = S.D.watches.items, keys = S.D.keys.items;
  if (!keys.length) return first('Start with a key', 'API Check watches a cloud with your own API key. Add one for Lambda, UpCloud, Nebius or RunPod; it is checked with the provider and stored encrypted.', `<button type="button" class="btn" data-act="keyAdd">${ico('plus', 16)}Add a key</button>`,
    ['Add a key for the cloud you want a machine from.', 'Create a watch: the exact configuration, the regions, and whether to only tell you or also start the machine.', 'API Check checks every few seconds and emails you the moment it sees the machine free, or starts it.']);
  if (!l.length) return first('Create your first watch', 'A watch looks for one or more configurations in the regions you choose, as often as the provider allows, and tells you or starts the machine when one is free.', `<a href="#new" class="btn">${ico('plus', 16)}New watch</a>`);
  const on = l.filter(w => w.state === 'on'), seen = l.map(w => w.lastSeen || 0).sort((a, b) => b - a)[0], checks = l.reduce((a, w) => a + (S.live[w.id] ? S.live[w.id].checks : w.checks), 0);
  const nowFree = on.filter(w => ((S.live[w.id] && S.live[w.id].found) || (w.status && w.status.found) || []).length);
  return `<dl class="facts"><div><dt>Watching now</dt><dd>${on.length}</dd><dd class="hint">of ${s(l.length, 'watch', 'watches')}</dd></div>
      <div><dt>Free right now</dt><dd class="${nowFree.length ? 'go' : ''}">${nowFree.length}</dd><dd class="hint">${nowFree.length ? esc(nowFree.map(w => w.name).join(', ')) : 'nothing your watches are looking for'}</dd></div>
      <div><dt>Last seen free</dt><dd class="small">${seen ? esc(ago(seen)) : 'not yet'}</dd><dd class="hint">across all watches</dd></div>
      <div><dt>Checks made</dt><dd>${nf().format(checks)}</dd><dd class="hint">${S.me.mailReady ? 'emails go to ' + esc(S.me.notifyEmail) : 'email is not set up'}</dd></div></dl>
    <section class="block"><div class="block-h"><h2>Watches</h2></div><div class="wl" id="wl">${l.map(wRow).join('')}</div></section>`;
}
function first(h, p, act, steps) {
  return `<div class="first"><h2>${esc(h)}</h2><p>${esc(p)}</p>${steps ? `<ol>${steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}${act}</div>`;
}
function wRow(w) {
  const l = S.live[w.id], found = (l ? l.found : (w.status && w.status.found)) || [], err = l ? l.err : w.error, last = l && l.lastAt ? l.lastAt : w.lastCheck;
  const nowLine = w.state !== 'on' ? esc(w.stopReason || (w.state === 'paused' ? 'Paused by you' : '')) : err ? `<span class="st st-warn"><i></i>${esc(err.slice(0, 120))}</span>` : found.length ? foundChips(w, found) : `Not free · checked <span data-ago="${last || 0}">${esc(ago(last))}</span>`;
  return `<article class="wrow" data-k="${esc(w.id)}"><div class="w-name"><a href="#watch/${esc(w.id)}">${esc(w.name)}</a><div class="w-line">${pdot(w.provider)}<span>${esc(pv(w.provider).name)} · ${esc(w.keyLabel)}</span><span>${w.mode === 'launch' ? `Starts ${w.launched}/${w.maxLaunch}` : 'Tells you'}</span><span>every ${esc(shortDur(w.every))}</span></div></div>
    <div class="w-what"><b>${esc(whatLine(w))}</b><span class="meta">${esc(whereLine(w))}</span></div>
    <div class="w-now">${watchState(w)}<span>${nowLine}</span></div>
    <div class="w-act">${w.state === 'on' ? `<button type="button" class="btn ghost sm" data-act="wPause" data-id="${esc(w.id)}">${ico('pause', 15)}Pause</button>` : w.state === 'done' && w.mode === 'launch' && w.launched >= w.maxLaunch ? '' : `<button type="button" class="btn ghost sm" data-act="wResume" data-id="${esc(w.id)}">${ico('play', 15)}Resume</button>`}<a class="btn ghost sm" href="#watch/${esc(w.id)}">Open</a></div></article>`;
}

/* ---------- one watch ---------- */
function vWatch() {
  const {watch: w, events, windows, launches} = S.D.one, P = pv(w.provider), l = S.live[w.id] || {}, found = (l.found || (w.status && w.status.found) || []);
  const err = l.err !== undefined ? l.err : w.error;
  const banner = w.state === 'stopped' ? `<p class="banner crit" role="alert"><span><b>Stopped.</b> ${esc(w.stopReason)}</span><button type="button" class="btn sm" data-act="wResume" data-id="${esc(w.id)}">Resume</button></p>`
    : w.state === 'done' ? `<p class="banner go"><span><b>Finished.</b> ${esc(w.stopReason)}</span></p>` : err ? `<p class="banner warn" role="status"><span><b>Cannot check right now.</b> ${esc(err)} API Check keeps trying with a growing delay.</span></p>` : '';
  const big = w.state !== 'on' ? `<span class="big">${w.state === 'paused' ? 'Paused' : w.state === 'done' ? 'Finished' : 'Stopped'}</span>` : found.length ? `<span class="big go">Free now</span>` : `<span class="big">Not free</span>`;
  const next = l.next && w.state === 'on' ? `<span class="meta" data-next="${l.next}" data-every="${w.every}">next check in <span>${Math.max(0, Math.round((l.next - Date.now()) / 1000))} s</span></span>` : '';
  return `${banner}<section class="live"><div><h3>Right now</h3><div class="pulse">${w.state === 'on' ? ring() : ''}<div>${big}${next}</div></div>
      ${found.length ? `<table class="grid-m" style="margin-top:14px"><thead><tr><th>Configuration</th><th>${esc(P.regionsLabel.replace(/s$/, ''))}</th><th>Level</th></tr></thead><tbody>${found.map(o => `<tr><td class="cfg"><b>${esc(cfgName(w, o.config))}</b></td><td>${esc(o.region)}</td><td>${lv(o.level, o.note)}${o.note ? ` <span class="mute">${esc(o.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      <dl class="kv" style="margin-top:16px"><dt>Last check</dt><dd><span data-ago="${l.lastAt || w.lastCheck || 0}">${esc(ago(l.lastAt || w.lastCheck))}</span></dd><dt>Checks</dt><dd class="num">${nf().format(l.checks || w.checks)}</dd><dt>Last seen free</dt><dd>${esc(w.lastSeen ? when(w.lastSeen) : 'not yet')}</dd>${w.lastNotified ? `<dt>Last email</dt><dd>${esc(when(w.lastNotified))}</dd>` : ''}</dl></div>
    <div><h3>What it looks for</h3><dl class="kv"><dt>Configurations</dt><dd>${w.spec.configs.map((c, i) => `${w.spec.configs.length > 1 ? (i + 1) + '. ' : ''}${esc(cfgName(w, c))}${w.spec.prices && w.spec.prices[c] ? ` <span class="mute">${esc(perHour(w.spec.prices[c], w.spec.currency))}</span>` : ''}`).join('<br>')}</dd>
      <dt>${esc(P.regionsLabel)}</dt><dd>${esc(whereLine(w))}</dd>${paramsLine(w)}
      ${P.signal === 'level' || P.signal === 'count' ? `<dt>Counts as free</dt><dd>${esc(levelWord(w.spec.minLevel))}</dd>` : ''}
      <dt>When found</dt><dd>${w.mode === 'launch' ? `Start ${s(w.maxLaunch, 'machine')} (${w.launched} started)${w.spec.group ? `, shared with the group “${esc(w.spec.group)}”` : ''}` : 'Email you'}${w.maxPrice ? `, only up to ${esc(perHour(w.maxPrice, w.spec.currency))}` : ''}</dd>
      <dt>Interval</dt><dd>every ${esc(dur(w.every))}${w.mode === 'notify' ? `, quiet time ${esc(dur(w.renotify * 60))}` : ''}</dd>
      ${w.startsAt || w.endsAt ? `<dt>Active</dt><dd>${w.startsAt ? 'from ' + esc(when(w.startsAt)) : 'from creation'}${w.endsAt ? ' until ' + esc(when(w.endsAt)) : ''}</dd>` : ''}
      <dt>Key</dt><dd>${pdot(w.provider)} ${esc(P.name)} · <a href="#keys">${esc(w.keyLabel)}</a></dd></dl></div></section>
    ${launches.length ? `<section class="block"><div class="block-h"><h2>Machines this watch started</h2></div>${machineTable(launches)}</section>` : ''}
    <section class="block"><div class="block-h"><h2>When it was free</h2><p class="hint">The last 24 hours, by configuration and ${esc(P.regionsLabel.toLowerCase().replace(/s$/, ''))}, as this watch saw it. Below: the share of each hour of the week with something free, over the last 7 days.</p></div>${strip(w, windows)}${heat(windows)}</section>
    <section class="block"><div class="block-h"><h2>Log</h2></div>${log(events)}</section>`;
}
const levelWord = l => ({low: 'any availability, low included', medium: 'medium or high', high: 'high only'}[l || 'low']);
function paramsLine(w) {
  const ps = PARAMS[w.provider]; if (!ps) return '';
  return ps.map(p => { const v = w.spec.params && w.spec.params[p.id]; const c = p.choices.find(x => String(x[0]) === String(v ?? p.def)); return `<dt>${esc(p.label)}</dt><dd>${esc(c ? c[1] : v)}</dd>`; }).join('');
}
function strip(w, windows) {
  const now = Date.now(), from = now - 86400e3, lanes = new Map();
  for (const x of windows) { const e = x.end_at || now; if (e < from) continue; const k = x.target + '|' + x.region; if (!lanes.has(k)) lanes.set(k, []); lanes.get(k).push([Math.max(x.start_at, from), e, x.level]); }
  if (!lanes.size) return `<p class="empty calm">Nothing this watch looks for was free in the last 24 hours.</p>`;
  const hours = [0, 6, 12, 18, 24].map(h => tf({hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(from + h * 3600e3)));
  return `<div class="strip">${[...lanes].map(([k, ws]) => { const [t, r] = k.split('|'), name = cfgName(w, t) + ' · ' + r, total = ws.reduce((a, [x, y]) => a + (y - x), 0);
    return `<div class="lane"><span title="${esc(name)}">${esc(name)}</span><div class="track" role="img" aria-label="${esc(name)}: free ${ws.length} times, ${esc(dur(Math.round(total / 1000)))} in total">${ws.map(([a, b, lvv]) => `<i class="${lvv === 'low' ? 'low' : ''}" style="left:${((a - from) / 864e3).toFixed(2)}%;width:${Math.max(.3, (b - a) / 864e3).toFixed(2)}%" title="${esc(timeOnly(a))} to ${esc(timeOnly(b))}"></i>`).join('')}</div></div>`; }).join('')}
    <div class="axis"><span></span><div>${hours.map(h => `<span>${h}</span>`).join('')}</div></div></div>`;
}
/* hour of the week, in your local time: how much of each hour had something free */
function heat(windows) {
  const now = Date.now(), from = now - 7 * 86400e3, cell = Array.from({length: 7}, () => Array(24).fill(0));
  for (const x of windows) {
    let a = Math.max(x.start_at, from); const b = Math.min(x.end_at || now, now);
    while (a < b) { const d = new Date(a), next = Math.min(b, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()); cell[(d.getDay() + 6) % 7][d.getHours()] += (next - a) / 3600e3; a = next; }
  }
  const any = cell.some(r => r.some(v => v > 0)); if (!any) return '';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return `<div class="heat" role="img" aria-label="Share of each hour of the week with capacity free, last 7 days"><div class="heat-g">${days.map((d, i) => `<span class="hd">${d}</span>${cell[i].map((v, h) => `<i style="--v:${Math.min(1, v).toFixed(2)}" title="${d} ${String(h).padStart(2, '0')}:00, free ${Math.round(Math.min(1, v) * 60)} min"></i>`).join('')}`).join('')}<span></span>${[0, 6, 12, 18].map(h => `<span class="hh" style="grid-column:${h + 2} / span 6">${String(h).padStart(2, '0')}</span>`).join('')}</div></div>`;
}
const SEV = {ok: 'ok', warn: 'warn', crit: 'crit', info: ''};
function log(items, withWatch) {
  if (!items.length) return `<p class="empty calm">Nothing has happened yet.</p>`;
  return `<div class="log">${items.map(e => `<div class="ev ${SEV[e.sev] || ''}"><time datetime="${new Date(e.at).toISOString()}" title="${esc(new Date(e.at).toLocaleString())}">${esc(when(e.at))}</time><span class="m" aria-hidden="true"></span><span><b>${esc(e.title)}</b>${withWatch && e.watch_id && e.watch_name ? `<a class="w" href="#watch/${esc(e.watch_id)}">${esc(e.watch_name)}</a>` : ''}</span>${e.detail ? `<span class="d">${esc(e.detail)}</span>` : ''}</div>`).join('')}</div>`;
}

/* ---------- the watch editor ---------- */
function newEd(base) {
  const keys = S.D.keys.items.filter(k => k.status === 'ok'), q = new URLSearchParams(location.hash.split('?')[1] || '');
  const k = base ? S.D.keys.items.find(x => x.id === base.keyId) : keys.find(x => x.id === q.get('key')) || (keys.length === 1 ? keys[0] : null);
  const e = {id: base ? base.id : null, keyId: k ? k.id : null, provider: k ? k.provider : null, cat: null, catErr: null, loading: false,
    params: base ? {...(base.spec.params || {})} : {}, configs: base ? [...base.spec.configs] : q.get('config') ? [q.get('config')] : [], regions: base ? [...(base.spec.regions || [])] : q.get('region') ? [q.get('region')] : [],
    names: base ? {...(base.spec.names || {})} : {}, prices: base ? {...(base.spec.prices || {})} : {}, currency: base ? base.spec.currency : 'USD',
    mode: base ? base.mode : 'notify', launch: base ? {...(base.spec.launch || {})} : {}, every: base ? base.every : null, minLevel: base ? base.spec.minLevel || 'low' : 'low',
    renotify: base ? base.renotify : 30, maxLaunch: base ? base.maxLaunch : 1, maxPrice: base && base.maxPrice != null ? base.maxPrice : '', startsAt: base ? base.startsAt : null, endsAt: base ? base.endsAt : null,
    startNow: base ? base.state === 'on' : true, name: base ? base.name : '', named: !!base, group: base ? base.spec.group || '' : '', q: '', gpu: 'all', onlyFree: false, bound: base ? base.spec.boundRegion || null : null};
  if (k && e.every == null) e.every = (LIMITS[k.provider] || {def: 30}).def;
  if (k) for (const p of PARAMS[k.provider] || []) if (e.params[p.id] == null) e.params[p.id] = p.def;
  if (q.get('params')) try { Object.assign(e.params, JSON.parse(q.get('params'))); } catch { /* ignore */ }
  return e;
}
async function loadCat() {
  const e = S.ed; if (!e || !e.keyId) return;
  e.loading = true; e.catErr = null; paintEd();
  try { e.cat = await api.catalog(e.keyId, e.params); } catch (x) { if (x.code === 'auth') return expired(); e.cat = null; e.catErr = apiMsg(x); }
  e.loading = false;
  if (e.cat) { for (const id of e.configs) { const c = e.cat.configs.find(x => x.id === id); if (c) { e.names[id] = c.name; if (c.price) e.prices[id] = c.price; e.currency = c.currency || 'USD'; } } }
  if (e.cat && S.route === 'new' && !e.configs.length) { /* nothing chosen yet */ }
  paintEd();
}
const offersFor = (cat, id) => (cat && cat.offers ? cat.offers.filter(o => o.config === id) : []);
const specLine = c => [c.gpus ? `${c.gpus}× ${c.gpu}${c.vramGb ? ' ' + c.vramGb + ' GB' : ''}` : c.gpu, c.vcpus ? c.vcpus + ' vCPU' : '', c.ramGb ? nf().format(c.ramGb) + ' GB RAM' : '', c.diskGb ? nf().format(c.diskGb) + ' GB disk' : ''].filter(Boolean).join(' · ');
function vEditor() {
  const e = S.ed, keys = S.D.keys.items;
  if (!keys.length) return first('Add a key first', 'A watch runs with one of your provider keys.', `<button type="button" class="btn" data-act="keyAdd">${ico('plus', 16)}Add a key</button>`);
  return `<div class="wiz"><div class="wiz-main" id="wizMain">${edSteps()}</div><aside class="wiz-side" id="wizSide" aria-live="polite">${edSide()}</aside></div>`;
}
function edSteps() {
  const e = S.ed, P = e.provider ? pv(e.provider) : null, keys = S.D.keys.items;
  const step = (n, h, body, off) => `<section class="step${off ? ' off' : ''}"><span class="no" aria-hidden="true">${n}</span><div class="body"><h2>${h}</h2>${body}</div></section>`;
  const keyStep = `${e.id ? `<p class="lead">${pdot(e.provider)} ${esc(P.name)} · ${esc((keys.find(k => k.id === e.keyId) || {}).label || '')}. A watch keeps its key; to watch another cloud, create a new watch.</p>`
    : `<div class="choice" role="radiogroup" aria-label="Key">${keys.map(k => `<label><input type="radio" name="edKey" value="${esc(k.id)}" data-chg="edKey"${k.id === e.keyId ? ' checked' : ''}${k.status !== 'ok' ? ' disabled' : ''}><b>${pdot(k.provider)} ${esc(k.label)}</b><small>${esc(pv(k.provider).name)}${k.account ? ' · ' + esc(k.account) : ''}${k.status !== 'ok' ? ' · refused by the provider' : ''}</small></label>`).join('')}</div>
      <p class="hint">Another cloud? <button type="button" class="lnk" data-act="keyAdd">Add a key</button>.</p>`}`;
  if (!e.keyId) return step(1, 'Which cloud', keyStep) + step(2, 'What to look for', '<p class="hint">Choose a key first.</p>', true) + step(3, 'Where', '', true) + step(4, 'When it is found', '', true) + step(5, 'How often', '', true);
  const params = (PARAMS[e.provider] || []).map(p => `<div class="fld"><span>${esc(p.label)}</span>${seg('edParam', e.params[p.id] ?? p.def, p.choices, p.label).replace(/data-act="edParam"/g, `data-act="edParam" data-p="${esc(p.id)}"`)}</div>`).join('');
  const sig = `<p class="note">${esc(P.signalText)}</p>`;
  let what;
  if (e.loading && !e.cat) what = `<div class="skel" aria-busy="true" aria-label="Reading the provider's catalogue"><i></i><i></i><i></i></div>`;
  else if (e.catErr) what = `<p class="banner crit" role="alert"><span>${esc(e.catErr)}</span><button type="button" class="btn sm" data-act="edReload">Try again</button></p>`;
  else if (e.cat) what = picker();
  else what = '';
  return step(1, 'Which cloud', keyStep)
    + step(2, 'What to look for', `${params ? `<div class="three-f">${params}</div>` : ''}${sig}${what}`)
    + step(3, P.regionsLabel === 'Zones' ? 'In which zones' : P.regionsLabel === 'Data centers' ? 'In which data centers' : 'In which regions', e.cat ? whereStep() : '<p class="hint">The list comes with the catalogue.</p>', !e.cat)
    + step(4, 'When it is found', foundStep(), !e.cat)
    + step(5, 'How often, and for how long', oftenStep(), !e.cat)
    + step(6, 'Name', `<label class="fld"><span class="vh">Name</span><input type="text" id="edName" data-ed="name" maxlength="80" value="${esc(e.name || autoName())}" placeholder="${esc(autoName())}"></label>`, !e.cat);
}
function picker() {
  const e = S.ed, cat = e.cat, gpus = [...new Set(cat.configs.map(c => c.gpu).filter(Boolean))];
  let list = cat.configs;
  if (e.gpu !== 'all') list = list.filter(c => c.gpu === e.gpu);
  if (e.q) { const q = e.q.toLowerCase(); list = list.filter(c => (c.name + ' ' + c.id + ' ' + c.gpu).toLowerCase().includes(q)); }
  if (e.onlyFree && cat.offers) list = list.filter(c => offersFor(cat, c.id).length || e.configs.includes(c.id));
  const free = c => offersFor(cat, c.id);
  const rows = list.map(c => { const o = free(c), on = e.configs.includes(c.id);
    return `<label class="opt"><input type="checkbox" data-chg="edCfg" value="${esc(c.id)}"${on ? ' checked' : ''}><span><b>${esc(c.name)}</b><span class="spec">${esc(specLine(c))}${c.name !== c.id ? ` · <code>${esc(c.id)}</code>` : ''}</span>${c.note ? `<span class="spec">${esc(c.note)}</span>` : ''}</span>
      <span class="right">${c.price ? `<span class="price">${esc(perHour(c.price, c.currency))}</span>` : '<span class="mute">price not listed</span>'}${cat.offers ? (o.length ? `<span class="lv lv-high"><span class="bars" aria-hidden="true"><b></b><b></b><b></b></span>Free in ${o.length}</span>` : '<span class="mute">not free now</span>') : ''}</span>
      ${o.length ? `<span class="where">${o.slice(0, 8).map(x => `<span class="tag ${levelRank(x.level) >= 2 ? 'go' : 'warn'}">${esc(x.region)}${x.level !== 'yes' ? ' · ' + esc(LEVEL_NAME[x.level]) : ''}</span>`).join('')}${o.length > 8 ? `<span class="tag">+${o.length - 8}</span>` : ''}</span>` : ''}</label>`; }).join('');
  const order = e.configs.length > 1 ? `<div class="fld"><span>Order of preference</span><small>When more than one is free, the first in this list wins. ${e.mode === 'launch' ? 'Only one machine per check is started.' : ''}</small><ol class="order">${e.configs.map((id, i) => `<li><span class="n">${i + 1}</span><span class="t">${esc(e.names[id] || id)}</span><button type="button" class="ib" data-act="edUp" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${ico('up', 15)}</button><button type="button" class="ib" data-act="edDown" data-i="${i}" aria-label="Move down"${i === e.configs.length - 1 ? ' disabled' : ''}>${ico('down', 15)}</button></li>`).join('')}</ol></div>` : '';
  return `<div class="pick"><div class="pick-h"><label class="search"><span class="vh">Search configurations</span>${ico('search', 16)}<input type="search" id="edQ" data-ed="q" value="${esc(e.q)}" placeholder="Search: H100, 8x, B200…"></label>
      <div class="ctl">${gpus.length > 1 && gpus.length < 14 ? `<label class="sel"><span class="vh">GPU</span><select data-chg="edGpu"><option value="all">All GPUs</option>${gpus.map(g => `<option${g === e.gpu ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>` : ''}${cat.offers ? `<label class="chk"><input type="checkbox" data-chg="edOnlyFree"${e.onlyFree ? ' checked' : ''}><span>Free now only</span></label>` : ''}
      <button type="button" class="btn ghost sm" data-act="edReload"${e.loading ? ' aria-busy="true"' : ''}>${ico('sync', 15)}Refresh</button></div></div>
    <div class="pick-l" role="group" aria-label="Configurations">${rows || `<p class="empty" style="padding:16px">Nothing matches.</p>`}</div></div>
    <p class="hint">${s(cat.configs.length, 'configuration')} from ${esc(pv(e.provider).name)}, read ${esc(ago(cat.at))}.${e.configs.length ? ` <b>${e.configs.length} chosen.</b>` : ''}</p>${order}
    ${cat.notes && cat.notes.length ? `<div class="note">${cat.notes.map(n => esc(n)).join('<br>')}</div>` : ''}`;
}
function whereStep() {
  const e = S.ed, cat = e.cat, P = pv(e.provider), sel = new Set(e.regions), freeIn = new Set((cat.offers || []).filter(o => e.configs.includes(o.config)).map(o => o.region));
  const sold = new Set(cat.configs.filter(c => e.configs.includes(c.id)).flatMap(c => c.regions || []));
  const regs = cat.regions.filter(r => !sold.size || sold.has(r.id) || sel.has(r.id) || freeIn.has(r.id));
  if (e.bound) return `<p class="note"><b>${esc(e.bound)} only.</b> A ${esc(boundWhat())} you chose lives in that ${esc(P.regionsLabel.toLowerCase().replace(/s$/, ''))}, so the watch is limited to it.</p>`;
  const any = !e.regions.length;
  return `<div class="ctl">${seg('edAny', any ? 'any' : 'pick', [['any', 'Any'], ['pick', 'Only these']], 'Regions')}</div>
    ${any ? `<p class="hint">Any of ${s(regs.length, P.regionsLabel.toLowerCase().replace(/s$/, ''), P.regionsLabel.toLowerCase())} where it is sold. When several are free at once, the one with the higher level goes first.</p>`
      : `<div class="regions" role="group" aria-label="${esc(P.regionsLabel)}">${regs.map(r => `<button type="button" class="chip" data-act="edReg" data-v="${esc(r.id)}" aria-pressed="${sel.has(r.id)}">${freeIn.has(r.id) ? '<span class="lv lv-high" aria-label="free now"><span class="bars"><b></b><b></b><b></b></span></span>' : ''}${esc(r.name)}${sel.has(r.id) ? ` <span class="mute">${e.regions.indexOf(r.id) + 1}</span>` : ''}</button>`).join('')}</div><p class="hint">The number on a chosen chip is its order of preference.</p>`}`;
}
const boundWhat = () => { const e = S.ed, f = pv(e.provider).launch.find(x => x.regionBound && e.launch[x.id]); return f ? f.label.toLowerCase() : 'resource'; };
function foundStep() {
  const e = S.ed, P = pv(e.provider);
  const mode = `<div class="choice" role="radiogroup" aria-label="When it is found">
    <label><input type="radio" name="edMode" value="notify" data-chg="edMode"${e.mode === 'notify' ? ' checked' : ''}><b>Email me</b><small>Fast and free. You start the machine yourself, if it is still there.</small></label>
    <label><input type="radio" name="edMode" value="launch" data-chg="edMode"${e.mode === 'launch' ? ' checked' : ''}><b>Start the machine</b><small>API Check creates it at once with the settings below and emails you. Billing starts at the provider.</small></label></div>`;
  if (e.mode !== 'launch') return mode;
  const opts = (e.cat && e.cat.options) || {};
  const fields = P.launch.map(f => fieldHtml(f, opts)).join('');
  return `${mode}<div class="two-f"><label class="fld"><span>How many machines</span><span class="unit"><input type="number" min="1" max="10" step="1" id="edMax" data-ed="maxLaunch" value="${esc(e.maxLaunch)}"> at most</span><small>The watch finishes after this many. Each one bills by the hour.</small></label>
    <label class="fld"><span>Price cap <i>optional</i></span><span class="unit"><input type="number" min="0" step="0.01" id="edPrice" data-ed="maxPrice" value="${esc(e.maxPrice)}" placeholder="none"> ${esc(e.currency || 'USD')}/h</span><small>Skip configurations above this hourly price.</small></label></div>
    <label class="fld"><span>Shared group <i>optional</i></span><input type="text" id="edGroup" data-ed="group" maxlength="40" value="${esc(e.group || '')}" placeholder="for example: competition" autocomplete="off"><small>Hunting for the same machine with several watches, keys or providers? Give them one group name. The group starts no more machines in total than the number above; once it has them, its other launch watches stop.</small></label>
    <fieldset class="fld" style="border:0;padding:0;margin:0;display:grid;gap:14px"><legend class="vh">Launch settings</legend>${fields}</fieldset>
    ${P.notes && P.notes.length ? `<div class="note warn">${P.notes.map(n => esc(n)).join('<br>')}</div>` : ''}`;
}
function fieldHtml(f, opts) {
  const e = S.ed, v = e.launch[f.id] ?? f.def ?? '', id = 'lf_' + f.id, req = f.required ? '' : ' <i>optional</i>';
  const help = f.help ? `<small id="${id}H">${esc(f.help)}</small>` : '';
  if (f.type === 'toggle') return `<label class="tgl"><input type="checkbox" id="${id}" data-chg="edLaunchT" data-f="${esc(f.id)}"${(e.launch[f.id] ?? f.def) ? ' checked' : ''}><span>${esc(f.label)}</span></label>`;
  if (f.type === 'select') {
    const list = f.from ? (opts[f.from] || []) : (f.choices || []).map(([a, b]) => ({id: a, name: b}));
    const empty = f.from ? (f.empty || (f.required ? 'Choose…' : 'None')) : null;
    return `<label class="fld"><span>${esc(f.label)}${req}</span><select id="${id}" data-chg="edLaunch" data-f="${esc(f.id)}"${f.help ? ` aria-describedby="${id}H"` : ''}>${empty != null ? `<option value="">${esc(empty)}</option>` : ''}${list.map(o => `<option value="${esc(o.id)}"${String(o.id) === String(v) ? ' selected' : ''} data-region="${esc(o.region || '')}">${esc(o.name)}${o.region ? ' · ' + esc(o.region) : ''}${o.detail && !o.region ? ' · ' + esc(o.detail) : ''}</option>`).join('')}</select>${f.from && !list.length ? `<small>${f.required ? 'None found with this key. ' : ''}Nothing to choose from yet: create one in the provider's console, then refresh the list above.</small>` : ''}${help}</label>`;
  }
  if (f.type === 'textarea') return `<label class="fld"><span>${esc(f.label)}${req}</span><textarea id="${id}" data-ed="launch.${esc(f.id)}" rows="3" class="${f.code ? 'code' : ''}" spellcheck="false" placeholder="${esc(f.ph || '')}"${f.help ? ` aria-describedby="${id}H"` : ''}>${esc(v)}</textarea>${help}</label>`;
  if (f.type === 'number') return `<label class="fld"><span>${esc(f.label)}${req}</span><input type="number" id="${id}" data-ed="launch.${esc(f.id)}" value="${esc(v)}" min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.int ? 1 : 'any'}"${f.help ? ` aria-describedby="${id}H"` : ''}>${help}</label>`;
  return `<label class="fld"><span>${esc(f.label)}${req}</span><input type="text" id="${id}" data-ed="launch.${esc(f.id)}" value="${esc(v)}" maxlength="${f.max || 200}" placeholder="${esc(f.ph || '')}" spellcheck="false"${f.help ? ` aria-describedby="${id}H"` : ''}>${help}</label>`;
}
function oftenStep() {
  const e = S.ed, P = pv(e.provider), lim = LIMITS[e.provider] || {min: 5, def: 30};
  const presets = [lim.min, 10, 15, 30, 60, 300].filter((x, i, a) => x >= lim.min && a.indexOf(x) === i);
  const local = ms => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };
  return `<div class="fld"><span>Check every</span><div class="ctl">${seg('edEvery', e.every, presets.map(x => [x, shortDur(x)]), 'Interval')}<span class="unit"><input type="number" id="edEvery" data-ed="every" min="${lim.min}" max="${EVERY_MAX}" value="${esc(e.every)}" aria-label="Seconds between checks"> seconds</span></div>
      <small>${esc(P.name)} allows ${lim.min} seconds at the least${e.provider === 'lambda' ? ' (about one request a second, one launch every 12 seconds)' : e.provider === 'runpod' ? ' (a daily request budget shared by every call)' : e.provider === 'upcloud' ? ' (no published limit; kept polite)' : e.provider === 'hyperstack' ? ' (500 requests a minute per address, shared by everything on Cloudflare’s address)' : ''}. All watches on one key share one check, so more watches do not mean more requests.</small></div>
    ${P.signal === 'level' || P.signal === 'count' ? `<div class="fld"><span>Counts as free</span>${seg('edLevel', e.minLevel, [['low', 'Any level'], ['medium', 'Medium or high'], ['high', 'High only']], 'Minimum level')}<small>A low level means a launch may still fail. ${e.mode === 'launch' ? 'For launching, any level is usually right: trying costs nothing.' : ''}</small></div>` : ''}
    ${e.mode === 'notify' ? `<label class="fld"><span>Quiet time between emails</span><span class="unit"><input type="number" id="edRe" data-ed="renotify" min="1" max="1440" value="${esc(e.renotify)}"> minutes</span><small>You get one email when it appears. After it is gone, a new appearance is emailed only after this much time since the last email.</small></label>` : ''}
    <div class="two-f"><label class="fld"><span>Start <i>optional</i></span><input type="datetime-local" id="edStart" data-chg="edDate" data-f="startsAt" value="${esc(local(e.startsAt))}"></label>
      <label class="fld"><span>Stop <i>optional</i></span><input type="datetime-local" id="edEnd" data-chg="edDate" data-f="endsAt" value="${esc(local(e.endsAt))}"></label></div>
    <label class="tgl"><input type="checkbox" data-chg="edNow"${e.startNow ? ' checked' : ''}><span>${e.id ? 'Watching' : 'Start watching as soon as it is saved'}</span></label>`;
}
function autoName() {
  const e = S.ed; if (!e || !e.configs.length) return 'New watch';
  const n = e.names[e.configs[0]] || e.configs[0];
  return `${n}${e.configs.length > 1 ? ` +${e.configs.length - 1}` : ''} · ${pv(e.provider).name}`;
}
function edSide() {
  const e = S.ed; if (!e.keyId) return `<h3>Summary</h3><p class="say">Choose a key to begin.</p>`;
  const P = pv(e.provider), ps = e.configs.map(c => e.prices[c]).filter(x => x > 0), cost = ps.length ? Math.min(...ps) : null, top = ps.length ? Math.max(...ps) : null;
  const say = !e.configs.length ? 'Choose what to look for.'
    : `Every <b>${esc(shortDur(e.every))}</b>, ask ${esc(P.name)} whether <b>${esc(e.configs.map(c => e.names[c] || c).join(' or '))}</b> is free in <b>${esc(e.bound || (e.regions.length ? e.regions.join(', ') : 'any ' + P.regionsLabel.toLowerCase().replace(/s$/, '')))}</b>. ${e.mode === 'launch' ? `When it is, <b>start ${s(Number(e.maxLaunch) || 1, 'machine')}</b> and email you.` : 'When it is, <b>email you</b>.'}`;
  return `<h3>Summary</h3><p class="say">${say}</p>
    ${e.configs.length ? `<dl class="kv">${cost ? `<dt>Price</dt><dd>${esc(top > cost ? money(cost, e.currency) + ' to ' + perHour(top, e.currency) : perHour(cost, e.currency))}${e.mode === 'launch' ? `<br><span class="mute">${esc(money(top * 24, e.currency))} a day at most per machine</span>` : ''}</dd>` : ''}<dt>Requests</dt><dd>about ${nf().format(Math.round(86400 / Math.max(1, Number(e.every) || 1)))} a day, shared with your other watches on this key</dd>${e.endsAt ? `<dt>Until</dt><dd>${esc(when(e.endsAt))}</dd>` : ''}</dl>` : ''}
    ${e.mode === 'launch' && e.configs.length ? `<p class="note warn">A started machine bills until you terminate it in ${esc(P.name)}'s console. API Check never terminates machines.</p>` : ''}
    <p class="err" role="alert" id="edErr" hidden></p>
    <button type="button" class="btn" data-act="edSave"${!e.configs.length ? ' disabled' : ''}>${e.id ? 'Save changes' : e.startNow ? 'Save and start watching' : 'Save, paused'}</button>
    <a class="btn ghost" href="${e.id ? '#watch/' + esc(e.id) : '#watches'}">Cancel</a>`;
}
function paintEd() { if (!['new', 'edit'].includes(S.route) || !S.ed) return; const m = $('#wizMain'); if (!m) return; const keep = focusKey(document.activeElement), y = scrollY; m.innerHTML = edSteps(); $('#wizSide').innerHTML = edSide(); if (keep) { const el = $(keep); if (el) el.focus({preventScroll: true}); } scrollTo(0, y); }
const paintSide = () => { const x = $('#wizSide'); if (x) { const keep = focusKey(document.activeElement); x.innerHTML = edSide(); if (keep && keep.startsWith('#') && x.querySelector(keep)) $(keep).focus(); } };
async function saveEd() {
  const e = S.ed, err = $('#edErr'), b = $('[data-act=edSave]');
  const say = m => { err.textContent = m; err.hidden = false; };
  if (!e.configs.length) return say(API_ERR.configs);
  const body = {keyId: e.keyId, name: (e.name || '').trim() || autoName(), mode: e.mode, every: Number(e.every), maxLaunch: Number(e.maxLaunch) || 1, renotify: Number(e.renotify) || 30,
    maxPrice: e.maxPrice === '' || e.maxPrice == null ? null : Number(e.maxPrice), startsAt: e.startsAt, endsAt: e.endsAt, paused: !e.startNow,
    spec: {configs: e.configs, regions: e.bound ? [e.bound] : e.regions, minLevel: e.minLevel, params: e.params, launch: e.launch, names: e.names, prices: e.prices, currency: e.currency, boundRegion: e.bound || undefined, group: e.mode === 'launch' ? (e.group || '').trim() || undefined : undefined}};
  if (b.dataset.busy) return; b.dataset.busy = '1'; b.setAttribute('aria-busy', 'true');
  try {
    let id = e.id;
    if (id) { await api.patchWatch(id, body); await api.patchWatch(id, {state: e.startNow ? 'on' : 'paused'}).catch(x => { if (x.code !== 'launch_done' && x.code !== 'launch_unknown') throw x; }); }
    else id = (await api.addWatch(body)).id;
    S.ed = null; toast(e.id ? 'Saved.' : e.startNow ? 'Watching. You will be emailed when it is free.' : 'Saved, paused.'); go('watch/' + id);
  } catch (x) {
    if (x.code === 'auth') return expired();
    if (x.code === 'launch_field') { const f = pv(e.provider).launch.find(y => y.id === x.field); say(`Check “${f ? f.label : x.field}”.`); const el = $('#lf_' + x.field); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } }
    else if (x.code === 'every') say(`Choose an interval of ${x.min} seconds or more (up to an hour).`);
    else say(apiMsg(x));
  } finally { delete b.dataset.busy; b.removeAttribute('aria-busy'); }
}

/* ---------- availability board ---------- */
function vMarket() {
  const keys = S.D.keys.items.filter(k => k.status === 'ok'), m = S.mk;
  if (!keys.length) return first('No key to look with', 'The availability board reads the provider live with one of your keys.', `<button type="button" class="btn" data-act="keyAdd">${ico('plus', 16)}Add a key</button>`);
  if (!m.key || !keys.find(k => k.id === m.key)) { m.key = keys[0].id; m.data = null; }
  const k = keys.find(x => x.id === m.key), P = pv(k.provider);
  const params = (PARAMS[k.provider] || []).map(p => seg('mkParam', m.params[p.id] ?? p.def, p.choices, p.label).replace(/data-act="mkParam"/g, `data-act="mkParam" data-p="${esc(p.id)}"`)).join('');
  const tools = `<div class="tools"><div class="ctl"><label class="sel"><span class="vh">Key</span><select data-chg="mkKey">${keys.map(x => `<option value="${esc(x.id)}"${x.id === m.key ? ' selected' : ''}>${esc(pv(x.provider).name)} · ${esc(x.label)}</option>`).join('')}</select></label>${params}</div>
    <div class="ctl"><label class="chk"><input type="checkbox" data-chg="mkAll"${m.all ? ' checked' : ''}><span>Show configurations not free now</span></label><button type="button" class="btn ghost sm" data-act="mkLoad"${m.loading ? ' aria-busy="true"' : ''}>${ico('sync', 15)}Refresh</button></div></div>`;
  if (m.err) return tools + `<p class="banner crit" role="alert"><span>${esc(m.err)}</span></p>`;
  if (!m.data) return tools + `<div class="skel" aria-busy="true" aria-label="Reading availability"><i></i><i></i><i></i></div>`;
  const d = m.data;
  if (!d.offers) return tools + `<p class="note">${esc(P.signalText)}</p>`;
  const rows = d.configs.filter(c => m.all || offersFor(d, c.id).length), regs = d.regions.filter(r => d.offers.some(o => o.region === r.id) || (m.all && d.configs.some(c => !c.regions || c.regions.includes(r.id))));
  const watched = new Set(S.D.watches.items.filter(w => w.keyId === k.id && w.state === 'on').flatMap(w => w.spec.configs));
  const cell = (c, r) => { const o = d.offers.find(x => x.config === c.id && x.region === r.id); return o ? `<button type="button" class="lnk mkt-cell" data-act="mkWatch" data-c="${esc(c.id)}" data-r="${esc(r.id)}" title="Watch ${esc(c.name)} in ${esc(r.id)}">${lv(o.level, o.note)}</button>` : `<span class="mute" aria-label="not free">–</span>`; };
  return `${tools}<p class="hint" style="margin-bottom:12px">${esc(P.signalText)} Read ${esc(ago(d.at))}. Select a level to start a watch on that cell.</p>
    ${rows.length ? `<div class="scroll"><table class="grid-m"><thead><tr><th>Configuration</th><th class="r">Price</th>${regs.map(r => `<th title="${esc(r.name)}">${esc(r.id)}</th>`).join('')}</tr></thead><tbody>${rows.map(c => `<tr class="${watched.has(c.id) ? 'mine' : ''}"><td class="cfg"><b>${esc(c.name)}</b><span class="meta">${esc(specLine(c))}</span></td><td class="r num">${esc(perHour(c.price, c.currency))}</td>${regs.map(r => `<td>${cell(c, r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">Nothing is free with this key right now. ${d.configs.length} configurations are sold; tick “Show configurations not free now” to see them, or set up a watch.</p>`}
    ${d.notes && d.notes.length ? `<div class="note" style="margin-top:18px">${d.notes.map(n => esc(n)).join('<br>')}</div>` : ''}`;
}
async function loadMarket() {
  const m = S.mk; if (!m.key) return; m.loading = true; m.err = null; if (S.route === 'market') paintMain();
  try { m.data = await api.catalog(m.key, m.params); } catch (x) { if (x.code === 'auth') return expired(); m.err = apiMsg(x); m.data = null; }
  m.loading = false; if (S.route === 'market') paintMain();
}

/* ---------- machines ---------- */
const LST = {created: ['Started', 'go'], pending: ['Being started', 'live'], failed: ['Refused', 'crit'], unknown: ['Not confirmed', 'warn']};
function machineTable(items) {
  return `<div class="scroll"><table class="tbl hov cards"><thead><tr><th>Machine</th><th>Configuration</th><th>Where</th><th>State</th><th class="r">Price</th><th class="hide-m">Started</th><th></th></tr></thead><tbody>${items.map(l => { const d = l.detail || {}, [t, tone] = LST[l.state] || [l.state, 'mute'];
    return `<tr><td class="c-name"><b class="wrap-any">${esc(l.name || l.extId || '')}</b><span class="meta">${pdot(l.provider)} ${esc(pv(l.provider).name)}${l.extId ? ' · <code>' + esc(l.extId) + '</code>' : ''}</span>${l.watchName ? `<span class="meta">by <a href="#watch/${esc(l.watchId)}">${esc(l.watchName)}</a></span>` : ''}</td>
      <td data-l="Configuration">${esc(l.target)}</td><td data-l="Where">${esc(l.region)}${d.ip ? `<span class="meta"><code>${esc(d.ip)}</code></span>` : ''}${d.ssh ? `<span class="meta"><code>${esc(d.ssh)}</code></span>` : ''}</td>
      <td data-l="State">${st(t, tone)}${d.status ? `<span class="meta">${esc(String(d.status).toLowerCase())}${d.readAt ? ', read ' + esc(ago(d.readAt)) : ''}</span>` : ''}${l.error ? `<span class="meta wrap-any">${esc(l.error)}</span>` : ''}</td>
      <td class="r" data-l="Price">${esc(perHour(l.price, l.currency))}</td><td class="hide-m mute">${esc(when(l.createdAt))}</td>
      <td class="r">${l.extId && l.state !== 'failed' ? `<button type="button" class="btn ghost sm" data-act="mRefresh" data-id="${esc(l.id)}">${ico('sync', 15)}Read status</button>` : ''}${pv(l.provider).site ? ` <a class="btn ghost sm" href="${esc(pv(l.provider).site)}" target="_blank" rel="noopener noreferrer">${ico('ext', 15)}Console</a>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function vMachines() {
  const l = S.D.launches.items;
  if (!l.length) return first('No machines started yet', 'Machines that your watches start appear here, with their address and status. API Check only starts machines; stopping and terminating them happens in the provider’s console.', `<a class="btn ghost" href="#watches">Your watches</a>`);
  return `<p class="note" style="margin:14px 0 6px">A started machine bills until you terminate it in the provider’s console. API Check never stops or terminates machines.</p>${machineTable(l)}`;
}

/* ---------- activity ---------- */
function vActivity() {
  const l = S.D.events.items;
  return `<div class="tools">${seg('aFilter', S.af, [['all', 'Everything'], ['seen', 'Seen and gone'], ['launch', 'Launches'], ['problem', 'Problems']], 'Show')}</div>${log(l, true)}
    ${l.length >= 100 ? `<p style="margin-top:14px"><button type="button" class="btn ghost" data-act="aMore">Earlier</button></p>` : ''}`;
}

/* ---------- keys ---------- */
function vKeys() {
  const l = S.D.keys.items;
  const add = `<button type="button" class="btn" data-act="keyAdd">${ico('plus', 16)}Add a key</button>`;
  if (!l.length) return first('No keys yet', 'Each key belongs to one provider account. It is checked with the provider when you add it, stored encrypted (AES-256-GCM, a key per record), and never shown again: only its last characters.', add);
  return `<div class="tools"><p class="count"><b>${l.length}</b> ${l.length === 1 ? 'key' : 'keys'}</p><div class="ctl">${add}</div></div>
    <div class="scroll"><table class="tbl hov cards"><thead><tr><th>Key</th><th>Provider</th><th>State</th><th class="r">Watches</th><th class="hide-m">Added</th><th></th></tr></thead><tbody>${l.map(k => `<tr>
      <td class="c-name"><b class="wrap-any">${esc(k.label)}</b><span class="meta">${k.tail ? `<code class="key">••••${esc(k.tail)}</code> ` : ''}${esc(k.account || '')}${k.comment ? ' · ' + esc(k.comment) : ''}</span></td>
      <td data-l="Provider">${pdot(k.provider)} ${esc(pv(k.provider).name)}</td>
      <td data-l="State">${k.status === 'ok' ? st('Working', 'go') : st('Refused', 'crit')}${k.status !== 'ok' && k.error ? `<span class="meta wrap-any">${esc(k.error)}</span>` : k.checkedAt ? `<span class="meta">checked ${esc(ago(k.checkedAt))}</span>` : ''}</td>
      <td class="r num" data-l="Watches">${k.active}/${k.watches}</td><td class="hide-m mute">${esc(when(k.createdAt))}</td>
      <td class="r"><div class="ctl" style="justify-content:flex-end"><a class="btn ghost sm" href="#new?key=${esc(k.id)}">New watch</a><button type="button" class="btn ghost sm" data-act="keyCheck" data-id="${esc(k.id)}">Check</button><button type="button" class="btn ghost sm" data-act="keyEdit" data-id="${esc(k.id)}">Edit</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- users ---------- */
const USER_ST = {active: ['Active', 'go'], invited: ['Link issued', 'live'], expired: ['Link expired', 'warn'], blocked: ['Blocked', 'mute']};
function vUsers() {
  const l = S.D.users.items;
  return `<div class="tools"><p class="count"><b>${l.length}</b> ${l.length === 1 ? 'user' : 'users'}</p><div class="ctl"><button type="button" class="btn" data-act="userAdd">${ico('plus', 16)}Create user</button></div></div>
    <div class="scroll"><table class="tbl hov cards"><thead><tr><th>User</th><th>Role</th><th>State</th><th class="r">Watches</th><th class="hide-m">Last sign-in</th></tr></thead><tbody>${l.map(u => `<tr><td class="c-name"><button type="button" class="row-btn" data-act="userOpen" data-id="${esc(u.id)}"><b>${esc(u.email)}</b><span class="meta">${u.me ? 'This is you' : esc(u.note || '')}</span></button></td>
      <td data-l="Role">${u.role === 'admin' ? 'Administrator' : 'Member'}</td><td data-l="State">${st(...USER_ST[u.status])}</td><td class="r num" data-l="Watches">${u.watches}</td><td class="hide-m mute">${esc(u.lastLogin ? when(u.lastLogin) : 'never')}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint" style="margin-top:14px">An administrator manages access and never sees other users' keys, watches or machines. Blocking a user stops all their watches.</p>`;
}

/* ---------- settings ---------- */
function vSettings() {
  const n = S.D.notices.items;
  return `<section class="block"><div class="block-h"><h2>Email</h2></div><div class="form">
      ${S.me.mailReady ? '' : '<p class="banner warn"><span>Email is not set up on this server, so nothing can be sent. The watches still run and log everything.</span></p>'}
      <label class="tgl"><input type="checkbox" data-chg="mail"${S.me.mail ? ' checked' : ''}><span>Email me when a watch sees capacity, starts a machine or stops</span></label>
      ${isAdmin() ? `<form class="form" data-form="notifyTo" novalidate><label class="fld"><span>Send to</span><input type="email" id="ntTo" value="${esc(S.me.notifyEmail)}" autocomplete="email"><small>Your sign-in address unless you name another one.</small></label><p class="err" role="alert" hidden></p><div class="ctl"><button class="btn ghost" type="submit">Save address</button><button type="button" class="btn ghost" data-act="testMail"${S.me.mailReady ? '' : ' disabled'}>Send a test</button></div></form>`
        : `<p>Emails go to <b>${esc(S.me.notifyEmail)}</b>. <button type="button" class="lnk" data-act="testMail"${S.me.mailReady ? '' : ' disabled'}>Send a test</button></p>`}</div></section>
    <section class="block"><div class="block-h"><h2>Sent recently</h2></div>${n.length ? `<div class="scroll"><table class="tbl cards"><thead><tr><th>When</th><th>Subject</th><th>Result</th></tr></thead><tbody>${n.map(x => `<tr><td class="mute nw">${esc(when(x.at))}</td><td class="wrap-any">${esc(x.subject)}</td><td data-l="Result">${x.result === 'sent' ? st('Sent', 'go') : x.result === 'off' ? st('Not sent: email off', 'mute') : st('Failed: ' + x.result.slice(7), 'crit')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty calm">Nothing sent yet.</p>'}</section>
    <section class="block"><div class="block-h"><h2>Password</h2></div><form class="form" data-form="password" novalidate>
      <label class="fld"><span>Current password</span><input type="password" id="pwCur" autocomplete="current-password" required></label>
      <label class="fld"><span>New password</span><input type="password" id="pwNew" autocomplete="new-password" minlength="8" required><small>8 characters or more. Other sessions end.</small></label>
      <p class="err" role="alert" hidden></p><div><button class="btn ghost" type="submit">Change password</button></div></form></section>
    <section class="block"><div class="block-h"><h2>Appearance</h2></div>${seg('themeSet', S.theme, [['auto', 'As the system'], ['light', 'Light'], ['dark', 'Dark']], 'Theme')}</section>`;
}

/* ---------- dialogs ---------- */
const dlg = () => $('#dlg');
const dHead = t => `<div class="d-h"><h2 id="dlgT">${esc(t)}</h2><button type="button" class="ib" data-act="close" aria-label="Close">${ico('x', 18)}</button></div>`;
function openDlg(html) { const d = dlg(); openDlg.back = focusKey(document.activeElement); d.innerHTML = `<div class="d-in">${html}</div>`; if (!d.open) d.showModal(); const f = $('[autofocus]', d) || $('input,select,textarea,button', d); if (f) f.focus(); }
function closeDlg() { const d = dlg(); if (d.open) d.close(); d.innerHTML = ''; }
function dKeyAdd(prov) {
  const list = Object.entries(PROV()), p = prov || store.get('lastProv', list[0][0]), P = pv(p);
  openDlg(`${dHead('Add a key')}<form class="form" data-form="keyAdd" novalidate>
    <div class="provs" role="radiogroup" aria-label="Provider">${list.map(([id, x]) => `<label><input type="radio" name="kpv" value="${esc(id)}" data-chg="kProv"${id === p ? ' checked' : ''}>${pdot(id)}${esc(x.name)}</label>`).join('')}</div>
    <p class="hint" id="kHelp">${esc(P.keyHelp)}</p>
    ${P.keyFields.map(f => f.type === 'textarea' ? `<label class="fld"><span>${esc(f.label)}</span><textarea id="kKey" class="code" rows="6" spellcheck="false" autocomplete="off" placeholder="${esc(f.ph || '')}" required></textarea></label>` : `<label class="fld"><span>${esc(f.label)}</span><input type="text" id="kKey" class="secret" autocomplete="off" spellcheck="false" placeholder="${esc(f.ph || '')}" required autofocus data-1p-ignore data-lpignore="true"></label>`).join('')}
    <label class="fld"><span>Name <i>optional</i></span><input type="text" id="kLabel" maxlength="60" placeholder="${esc(P.name)}"></label>
    <label class="fld"><span>Note <i>optional</i></span><input type="text" id="kNote" maxlength="500" placeholder="Whose account, what it is for"></label>
    <p class="hint">The key is sent once, checked with ${esc(P.name)}, and stored encrypted. It is never shown again.</p><p class="err" role="alert" hidden></p>
    <div class="d-f"><button type="button" class="btn ghost" data-act="close">Cancel</button><button type="submit" class="btn">Check and add</button></div></form>`);
}
function dKeyEdit(k) {
  openDlg(`${dHead(k.label)}<form class="form" data-form="keyEdit" data-id="${esc(k.id)}" novalidate>
    <label class="fld"><span>Name</span><input type="text" id="kLabel" maxlength="60" value="${esc(k.label)}" required></label>
    <label class="fld"><span>Note <i>optional</i></span><input type="text" id="kNote" maxlength="500" value="${esc(k.comment)}"></label>
    <label class="fld"><span>Replace the key <i>optional</i></span>${k.provider === 'nebius' ? `<textarea id="kKey" class="code" rows="5" spellcheck="false" autocomplete="off" placeholder="New credentials file"></textarea>` : `<input type="text" id="kKey" class="secret" autocomplete="off" spellcheck="false" placeholder="New key" data-1p-ignore data-lpignore="true">`}<small>A new key is checked with the provider. Its watches keep running with it.</small></label>
    <p class="err" role="alert" hidden></p>
    <div class="d-f"><button type="button" class="btn ghost danger" data-act="keyDel" data-id="${esc(k.id)}">Delete key</button><span style="flex:1"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button type="submit" class="btn">Save</button></div></form>`);
}
function dUserAdd() {
  openDlg(`${dHead('New user')}<form class="form" data-form="userAdd" novalidate>
    <label class="fld"><span>Email</span><input type="email" id="usEmail" autocomplete="off" required autofocus></label>
    <label class="fld"><span>Note <i>optional</i></span><input type="text" id="usNote" maxlength="120"></label>
    <label class="chk"><input type="checkbox" id="usAdmin"><span>Administrator: can create and block users</span></label>
    <p class="hint">The user sets their own password through a one-time link. You get the link in the next step.</p><p class="err" role="alert" hidden></p>
    <div class="d-f"><button type="button" class="btn ghost" data-act="close">Cancel</button><button type="submit" class="btn">Create and get the link</button></div></form>`);
}
const linkUrl = t => location.origin + '/#invite=' + t;
function dLink(email, r) {
  openDlg(`${dHead('Sign-in link')}<p>Pass this link to <b>${esc(email)}</b> yourself. It works once and is valid until ${esc(when(r.expires))}. It is not shown again.</p>
    <div class="copy-row"><input type="text" id="linkUrl" readonly value="${esc(linkUrl(r.invite))}" aria-label="Sign-in link"><button type="button" class="btn" data-act="copyLink" autofocus>Copy</button></div>
    <div class="d-f"><button type="button" class="btn ghost" data-act="close">Close</button></div>`);
}
function dUser(u) {
  const id = esc(u.id);
  openDlg(`${dHead(u.email)}<dl class="kv"><dt>Role</dt><dd>${u.role === 'admin' ? 'Administrator' : 'Member'}</dd><dt>State</dt><dd>${st(...USER_ST[u.status])}</dd><dt>Watches</dt><dd>${u.watches}</dd><dt>Last sign-in</dt><dd>${esc(u.lastLogin ? when(u.lastLogin) : 'never')}</dd>${u.note ? `<dt>Note</dt><dd>${esc(u.note)}</dd>` : ''}</dl>
    ${u.me ? '<p class="hint">This is you. Change your password in Settings.</p>' : `<div class="ctl">${u.status === 'blocked' ? '' : `<button type="button" class="btn ghost sm" data-act="userLink" data-id="${id}">${u.status === 'active' ? 'Reset password' : 'Issue a new link'}</button>`}
      <button type="button" class="btn ghost sm" data-act="userBlock" data-id="${id}">${u.status === 'blocked' ? 'Unblock' : 'Block'}</button>
      <button type="button" class="btn ghost sm" data-act="userRole" data-id="${id}">${u.role === 'admin' ? 'Make member' : 'Make administrator'}</button>
      <button type="button" class="btn ghost sm danger" data-act="userDel" data-id="${id}">Delete</button></div>`}
    <div class="d-f"><button type="button" class="btn" data-act="close">Close</button></div>`);
}
function dConfirm(title, text, act, id, label) {
  openDlg(`${dHead(title)}<p>${text}</p><div class="d-f"><button type="button" class="btn ghost" data-act="close" autofocus>Cancel</button><button type="button" class="btn danger-b" data-act="${act}" data-id="${esc(id)}" data-sure="1">${esc(label)}</button></div>`);
}

/* ---------- forms ---------- */
function fail(form, msg, el) { const e = $('.err', form); e.textContent = msg; e.hidden = false; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } return false; }
function clearErr(form) { const e = $('.err', form); if (e) { e.hidden = true; e.textContent = ''; } $$('[aria-invalid]', form).forEach(x => x.removeAttribute('aria-invalid')); }
const mailOk = v => v.length <= 254 && /^[\x21-\x7e]+$/.test(v) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
async function busy(form, fn) {
  const b = $('button[type=submit]', form); if (b.dataset.busy) return; b.dataset.busy = '1'; b.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (e) { if (e && e.code === 'auth' && S.me) return expired(); fail(form, apiMsg(e)); } finally { delete b.dataset.busy; b.removeAttribute('aria-busy'); }
}
async function enter() { S.me = await api.me(); S.link = null; S.linkBad = false; S.D = {}; S.ed = null; S.mk = {key: null, params: {}, data: null, all: false}; go('watches'); }
const FORMS = {
  login(f) {
    const em = $('#lgEmail', f), pw = $('#lgPass', f);
    if (!mailOk(em.value.trim())) return fail(f, 'Enter your email address.', em);
    if (pw.value.length < 8) return fail(f, 'The password has 8 characters or more.', pw);
    return busy(f, async () => { await api.login(em.value.trim(), pw.value); await enter(); });
  },
  setup(f) {
    const cd = $('#suCode', f), em = $('#lgEmail', f), pw = $('#lgPass', f), p2 = $('#lgPass2', f);
    if (!cd.value.trim()) return fail(f, 'Enter the setup code.', cd);
    if (!mailOk(em.value.trim())) return fail(f, 'Enter your email address.', em);
    if (pw.value.length < 8) return fail(f, API_ERR.password, pw); if (pw.value !== p2.value) return fail(f, 'The two passwords differ.', p2);
    return busy(f, async () => { await api.setup({token: cd.value.trim(), email: em.value.trim(), password: pw.value}); await enter(); });
  },
  link(f) {
    const pw = $('#lgPass', f), p2 = $('#lgPass2', f);
    if (pw.value.length < 8) return fail(f, API_ERR.password, pw); if (pw.value !== p2.value) return fail(f, 'The two passwords differ.', p2);
    return busy(f, async () => { await api.acceptLink(S.link.token, pw.value); await enter(); });
  },
  keyAdd(f) {
    const prov = ($('input[name=kpv]:checked', f) || {}).value, k = $('#kKey', f);
    if (!k.value.trim()) return fail(f, 'Paste the key.', k);
    return busy(f, async () => { const r = await api.addKey({provider: prov, key: k.value.trim(), label: $('#kLabel', f).value, comment: $('#kNote', f).value}); store.set('lastProv', prov); closeDlg(); toast(`Key checked with ${pv(prov).name} and added${r.account ? ' (' + r.account + ')' : ''}.`); S.me = await api.me(); if (S.route === 'new' && S.ed) { S.ed = null; } await render(); });
  },
  keyEdit(f) {
    const k = $('#kKey', f), b = {label: $('#kLabel', f).value, comment: $('#kNote', f).value}; if (k.value.trim()) b.key = k.value.trim();
    if (!b.label.trim()) return fail(f, API_ERR.label, $('#kLabel', f));
    return busy(f, async () => { await api.patchKey(f.dataset.id, b); closeDlg(); toast(b.key ? 'Key replaced and checked.' : 'Saved.'); await render(); });
  },
  userAdd(f) {
    const em = $('#usEmail', f); if (!mailOk(em.value.trim())) return fail(f, API_ERR.email, em);
    return busy(f, async () => { const r = await api.createUser({email: em.value.trim(), note: $('#usNote', f).value, role: $('#usAdmin', f).checked ? 'admin' : 'user'}); await render(); dLink(em.value.trim(), r); });
  },
  notifyTo(f) {
    const to = $('#ntTo', f); if (to.value.trim() && !mailOk(to.value.trim())) return fail(f, API_ERR.email, to);
    return busy(f, async () => { await api.updateMe({notifyEmail: to.value.trim()}); S.me = await api.me(); toast('Saved.'); await render(); });
  },
  password(f) {
    const c = $('#pwCur', f), n = $('#pwNew', f); if (n.value.length < 8) return fail(f, API_ERR.password, n);
    return busy(f, async () => { await api.updateMe({current: c.value, password: n.value}); c.value = n.value = ''; toast('Password changed. Other sessions have ended.'); });
  }
};

/* ---------- actions ---------- */
const keyOf = id => S.D.keys && S.D.keys.items.find(k => k.id === id);
const userOf = id => S.D.users && S.D.users.items.find(u => u.id === id);
const watchOf = id => (S.D.one && S.D.one.watch.id === id ? S.D.one.watch : S.D.watches && S.D.watches.items.find(w => w.id === id));
async function act(fn, ok) { try { await fn(); if (ok) toast(ok); } catch (e) { if (e.code === 'auth') return expired(); toast(apiMsg(e)); } }
const ACT = {
  skip() { const m = $('#main') || $('#lgEmail'); if (m) m.focus(); },
  toLogin() { S.link = null; S.linkBad = false; render(); },
  close: closeDlg,
  async logout() { await api.logout().catch(() => {}); S.me = null; S.D = {}; S.ed = null; setHash(''); try { S.auth = await api.authState(); } catch { /* fine */ } render(); },
  theme() { const order = ['auto', 'light', 'dark']; S.theme = order[(order.indexOf(S.theme) + 1) % 3]; store.set('theme', S.theme); applyTheme(); toast('Theme: ' + ({auto: 'as the system', light: 'light', dark: 'dark'}[S.theme])); },
  themeSet(el) { S.theme = el.dataset.v; store.set('theme', S.theme); applyTheme(); paintMain(); },
  keyAdd() { dKeyAdd(); },
  keyEdit(el) { dKeyEdit(keyOf(el.dataset.id)); },
  keyCheck(el) { act(async () => { const r = await api.checkKey(el.dataset.id); toast('The provider accepts the key' + (r.account ? ' (' + r.account + ').' : '.')); await render(); }); },
  keyDel(el) { const k = keyOf(el.dataset.id); if (!el.dataset.sure) return dConfirm('Delete key', `<b>${esc(k.label)}</b> and its ${s(k.watches, 'watch', 'watches')} will be deleted. Machines already started keep running at ${esc(pv(k.provider).name)}.`, 'keyDel', k.id, 'Delete key'); act(async () => { await api.deleteKey(k.id); closeDlg(); S.me = await api.me(); await render(); }, 'Key deleted.'); },
  wPause(el) { act(async () => { await api.patchWatch(el.dataset.id, {state: 'paused'}); await refresh(); }, 'Paused.'); },
  wResume(el) { act(async () => { await api.patchWatch(el.dataset.id, {state: 'on'}); await refresh(); }, 'Watching again.'); },
  wCheck(el) { act(async () => { await api.checkNow(el.dataset.id); setTimeout(refresh, 1500); }, 'Checking now.'); },
  wDel(el) { const w = watchOf(el.dataset.id); if (!el.dataset.sure) return dConfirm('Delete watch', `<b>${esc(w.name)}</b> and its log will be deleted. Machines it started keep running and stay listed under Machines.`, 'wDel', w.id, 'Delete watch'); act(async () => { await api.deleteWatch(w.id); closeDlg(); go('watches'); }, 'Watch deleted.'); },
  edReload() { loadCat(); },
  edParam(el) { S.ed.params[el.dataset.p] = /^\d+$/.test(el.dataset.v) ? Number(el.dataset.v) : el.dataset.v; S.ed.configs = []; loadCat(); },
  edUp(el) { const i = +el.dataset.i, c = S.ed.configs; [c[i - 1], c[i]] = [c[i], c[i - 1]]; paintEd(); },
  edDown(el) { const i = +el.dataset.i, c = S.ed.configs; [c[i + 1], c[i]] = [c[i], c[i + 1]]; paintEd(); },
  edAny(el) { if (el.dataset.v === 'any') S.ed.regions = []; else if (!S.ed.regions.length) { const free = (S.ed.cat.offers || []).filter(o => S.ed.configs.includes(o.config)).map(o => o.region); S.ed.regions = [...new Set(free)].slice(0, 1); if (!S.ed.regions.length && S.ed.cat.regions[0]) S.ed.regions = [S.ed.cat.regions[0].id]; } paintEd(); },
  edReg(el) { const r = S.ed.regions, v = el.dataset.v, i = r.indexOf(v); if (i >= 0) r.splice(i, 1); else r.push(v); paintEd(); },
  edEvery(el) { S.ed.every = Number(el.dataset.v); paintEd(); },
  edLevel(el) { S.ed.minLevel = el.dataset.v; paintEd(); },
  edSave() { saveEd(); },
  mkLoad() { loadMarket(); },
  mkParam(el) { S.mk.params[el.dataset.p] = /^\d+$/.test(el.dataset.v) ? Number(el.dataset.v) : el.dataset.v; loadMarket(); },
  mkWatch(el) { const k = keyOf(S.mk.key); go(`new?key=${encodeURIComponent(k.id)}&config=${encodeURIComponent(el.dataset.c)}&region=${encodeURIComponent(el.dataset.r)}&params=${encodeURIComponent(JSON.stringify(S.mk.params))}`); },
  mRefresh(el) { act(async () => { const r = await api.refreshLaunch(el.dataset.id); toast(`Status: ${String((r.detail && r.detail.status) || 'not found').toLowerCase()}${r.detail && r.detail.ip ? ', address ' + r.detail.ip : ''}.`); await render(); }); },
  aFilter(el) { S.af = el.dataset.v; render(); },
  async aMore() { const l = S.D.events.items, more = await api.events({before: l[l.length - 1].at, kind: S.af === 'all' ? '' : S.af}); S.D.events.items = l.concat(more.items); paintMain(); },
  testMail() { act(async () => { await api.testMail(); await render(); }, 'Test sent. Check your inbox.'); },
  userAdd() { dUserAdd(); },
  userOpen(el) { dUser(userOf(el.dataset.id)); },
  userLink(el) { const u = userOf(el.dataset.id); if (u.status === 'active' && !el.dataset.sure) return dConfirm('Reset password', `The password of <b>${esc(u.email)}</b> and every session stop working at once. You get a link to pass on.`, 'userLink', u.id, 'Reset and get the link'); act(async () => { const r = await api.newLink(u.id); await render(); dLink(u.email, r); }); },
  userBlock(el) { const u = userOf(el.dataset.id); act(async () => { await api.patchUser(u.id, {disabled: u.status !== 'blocked'}); closeDlg(); await render(); }, u.status === 'blocked' ? 'Unblocked.' : 'Blocked. Their watches have stopped.'); },
  userRole(el) { const u = userOf(el.dataset.id); act(async () => { await api.patchUser(u.id, {role: u.role === 'admin' ? 'user' : 'admin'}); closeDlg(); await render(); }, 'Role changed.'); },
  userDel(el) { const u = userOf(el.dataset.id); if (!el.dataset.sure) return dConfirm('Delete user', `Delete <b>${esc(u.email)}</b> with all their keys, watches and history? Machines they started keep running at the providers.`, 'userDel', u.id, 'Delete for good'); act(async () => { await api.deleteUser(u.id); closeDlg(); await render(); }, 'User deleted.'); },
  copyLink() { const el = $('#linkUrl'); el.select(); (navigator.clipboard ? navigator.clipboard.writeText(el.value) : Promise.reject()).then(() => toast('Link copied.'), () => toast('Select the link and copy it by hand.')); }
};
const CHG = {
  edKey(el) { const k = keyOf(el.value); S.ed = newEd(); S.ed.keyId = k.id; S.ed.provider = k.provider; S.ed.every = (LIMITS[k.provider] || {def: 30}).def; for (const p of PARAMS[k.provider] || []) S.ed.params[p.id] = p.def; paintEd(); loadCat(); },
  edCfg(el) { const e = S.ed, i = e.configs.indexOf(el.value); if (el.checked && i < 0) { e.configs.push(el.value); const c = e.cat.configs.find(x => x.id === el.value); if (c) { e.names[c.id] = c.name; if (c.price) e.prices[c.id] = c.price; e.currency = c.currency || 'USD'; } } else if (!el.checked && i >= 0) e.configs.splice(i, 1); paintEd(); },
  edGpu(el) { S.ed.gpu = el.value; paintEd(); },
  edOnlyFree(el) { S.ed.onlyFree = el.checked; paintEd(); },
  edMode(el) { S.ed.mode = el.value; paintEd(); },
  edLaunch(el) {
    const e = S.ed, f = pv(e.provider).launch.find(x => x.id === el.dataset.f), o = el.selectedOptions[0], reg = o ? o.dataset.region : '';
    e.launch[f.id] = el.value; delete e.launch[f.id + '_region'];
    if (f.regionBound) { if (reg) e.launch[f.id + '_region'] = reg; const bound = pv(e.provider).launch.filter(x => x.regionBound && e.launch[x.id + '_region']).map(x => e.launch[x.id + '_region']); e.bound = bound[0] || null; if (new Set(bound).size > 1) toast('These choices live in different regions; the watch uses the first.'); }
    paintEd();
  },
  edLaunchT(el) { S.ed.launch[el.dataset.f] = el.checked; paintSide(); },
  edDate(el) { S.ed[el.dataset.f] = el.value ? new Date(el.value).getTime() : null; paintSide(); },
  edNow(el) { S.ed.startNow = el.checked; paintSide(); },
  kProv(el) { const keep = ($('#kKey') || {}).value; dKeyAdd(el.value); const k = $('#kKey'); if (k && keep) k.value = keep; const r = $(`input[name=kpv][value="${el.value}"]`); if (r) r.focus(); },
  mkKey(el) { S.mk.key = el.value; S.mk.params = {}; S.mk.data = null; loadMarket(); },
  mkAll(el) { S.mk.all = el.checked; paintMain(); },
  mail(el) { act(async () => { await api.updateMe({mail: el.checked}); S.me = await api.me(); }, el.checked ? 'Emails on.' : 'Emails off. Watches still run and log.'); }
};

/* ---------- loading and painting ---------- */
async function load() {
  const r = S.route, D = {};
  if (r === 'watches') [D.watches, D.keys] = await Promise.all([api.watches(), api.keys()]);
  else if (r === 'watch') D.one = await api.watch(S.id);
  else if (r === 'new' || r === 'edit') { [D.keys, D.watches] = await Promise.all([api.keys(), api.watches()]); if (r === 'edit') D.one = await api.watch(S.id); }
  else if (r === 'market') [D.keys, D.watches] = await Promise.all([api.keys(), api.watches()]);
  else if (r === 'machines') D.launches = await api.launches();
  else if (r === 'activity') D.events = await api.events({kind: S.af === 'all' ? '' : S.af});
  else if (r === 'keys') D.keys = await api.keys();
  else if (r === 'users') D.users = await api.users();
  else if (r === 'settings') D.notices = await api.notices();
  return D;
}
function head() {
  const r = S.route;
  if (r === 'watches') return [NAV.watches, {right: S.D.keys && S.D.keys.items.length ? `<a class="btn" href="#new">${ico('plus', 16)}New watch</a>` : ''}];
  if (r === 'watch') { const w = S.D.one.watch; return [esc(w.name), {crumb: '<a class="crumb" href="#watches">Watches</a>', tag: watchState(w), right: `${w.state === 'on' ? `<button type="button" class="btn ghost sm" data-act="wCheck" data-id="${esc(w.id)}">${ico('bolt', 15)}Check now</button><button type="button" class="btn ghost sm" data-act="wPause" data-id="${esc(w.id)}">${ico('pause', 15)}Pause</button>` : w.state === 'done' && w.mode === 'launch' && w.launched >= w.maxLaunch ? '' : `<button type="button" class="btn sm" data-act="wResume" data-id="${esc(w.id)}">${ico('play', 15)}Resume</button>`}<a class="btn ghost sm" href="#edit/${esc(w.id)}">${ico('edit', 15)}Edit</a><button type="button" class="btn ghost sm danger" data-act="wDel" data-id="${esc(w.id)}">Delete</button>`}]; }
  if (r === 'new') return ['New watch', {crumb: '<a class="crumb" href="#watches">Watches</a>'}];
  if (r === 'edit') return ['Edit watch', {crumb: `<a class="crumb" href="#watch/${esc(S.id)}">${esc(S.D.one.watch.name)}</a>`}];
  return [NAV[r], {}];
}
const VIEW = {watches: vWatches, watch: vWatch, new: vEditor, edit: vEditor, market: vMarket, machines: vMachines, activity: vActivity, keys: vKeys, users: vUsers, settings: vSettings};
function paintMain() { const m = $('#main'); if (!m) return; const keep = focusKey(document.activeElement), y = scrollY; m.innerHTML = VIEW[S.route](); if (keep) { const el = $(keep); if (el) el.focus({preventScroll: true}); } scrollTo(0, y); tick(); }
let seq = 0;
async function render() {
  const my = ++seq, app = $('#app');
  if (!S.me) { document.title = 'API Check'; app.innerHTML = vLogin(); S.painted = ''; return; }
  if (S.route === 'users' && !isAdmin()) S.route = 'watches';
  if (S.painted !== S.route + S.id) app.innerHTML = shell(NAV[S.route] || '', `<div class="skel" aria-busy="true" aria-label="Loading"><i></i><i></i><i></i></div>`);
  let D;
  try { D = await load(); }
  catch (e) {
    if (my !== seq) return;
    if (e.code === 'auth') { S.me = null; return render(); }
    if (e.code === 'not_found' && ['watch', 'edit'].includes(S.route)) { setHash('watches', true); S.route = 'watches'; S.id = null; return render(); }
    app.innerHTML = shell('Something went wrong', `<p class="banner crit" role="alert"><span>${esc(apiMsg(e))}</span><button type="button" class="btn sm" data-act="retry">Retry</button></p>`); return;
  }
  if (my !== seq) return;
  S.D = D;
  if (S.route === 'new' && (!S.ed || S.ed.id)) { S.ed = newEd(); if (S.ed.keyId) loadCat(); }
  if (S.route === 'edit' && (!S.ed || S.ed.id !== S.id)) { S.ed = newEd(S.D.one.watch); loadCat(); }
  if (['watches', 'watch'].includes(S.route)) await pollLive();
  const moved = S.painted !== S.route + S.id; S.painted = S.route + S.id;
  const paint = () => { const [t, o] = head(); document.title = (t.replace(/<[^>]+>/g, '') || 'API Check') + ' | API Check'; app.innerHTML = shell(t, VIEW[S.route](), o); tick(); };
  const keep = focusKey(document.activeElement);
  if (moved && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) { try { await document.startViewTransition(paint).updateCallbackDone; } catch { paint(); } } else paint();
  if (!moved && keep) { const el = $(keep); if (el) el.focus({preventScroll: true}); }
  if (S.route === 'market' && !S.mk.data && !S.mk.loading) loadMarket();
}
ACT.retry = () => render();
const expired = () => { S.me = null; S.D = {}; closeDlg(); render().then(() => toast(API_ERR.auth)); };

/* ---------- live: what the engine knows this second ---------- */
async function pollLive() { try { const r = await api.live(); S.live = r.watches || {}; S.skew = Date.now() - r.at; } catch (e) { if (e.code === 'auth') expired(); } }
async function refresh() {
  if (!S.me || !['watches', 'watch'].includes(S.route) || dlg().open) return;
  try {
    if (S.route === 'watches') { S.D.watches = await api.watches(); await pollLive(); const wl = $('#wl'); if (!wl) return paintMain(); patchList(wl, S.D.watches.items.map(wRow)); const f = $('.facts'); if (f) { const t = document.createElement('div'); t.innerHTML = vWatches(); const nf2 = t.querySelector('.facts'); if (nf2 && nf2.innerHTML !== f.innerHTML) f.innerHTML = nf2.innerHTML; } }
    else { S.D.one = await api.watch(S.id); await pollLive(); const m = $('#main'); const t = document.createElement('div'); t.innerHTML = vWatch(); if (t.innerHTML !== lastWatchHtml) { lastWatchHtml = t.innerHTML; paintMain(); } const bar = $('.bar-l .st'); if (bar) bar.outerHTML = watchState(S.D.one.watch); }
  } catch (e) { if (e.code === 'auth') expired(); }
}
let lastWatchHtml = '';
/* rows are replaced one by one, only when they changed, so a button under the pointer stays put */
function patchList(host, rows) {
  const t = document.createElement('div'); t.innerHTML = rows.join('');
  const want = [...t.children], have = new Map([...host.children].map(c => [c.dataset.k, c]));
  if (want.length !== host.children.length || want.some((c, i) => host.children[i].dataset.k !== c.dataset.k)) { host.innerHTML = rows.join(''); return; }
  want.forEach(c => { const o = have.get(c.dataset.k); if (o && o.innerHTML !== c.innerHTML) { const keep = o.contains(document.activeElement) ? focusKey(document.activeElement) : ''; o.replaceWith(c); if (keep) { const el = $(keep); if (el) el.focus(); } } });
}
/* once a second: the "ago" labels and the countdown ring */
function tick() {
  for (const el of $$('[data-ago]')) { const v = Number(el.dataset.ago); el.textContent = ago(v); }
  for (const el of $$('[data-next]')) {
    const left = Math.max(0, Math.round((Number(el.dataset.next) - Date.now()) / 1000)), every = Number(el.dataset.every) || 1, span = el.querySelector('span');
    if (span) span.textContent = left ? left + ' s' : 'a moment';
    const r = el.closest('.pulse') && el.closest('.pulse').querySelector('.ring'); if (r) r.style.setProperty('--p', String(1 - Math.min(1, left / every)));
  }
}
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

/* ---------- routing ---------- */
function readHash() {
  const raw = location.hash.slice(1), [path] = raw.split('?'), [r, id] = path.split('/');
  let x = null; try { x = id ? decodeURIComponent(id) : null; } catch { /* a mangled address opens the list */ }
  return {r: ROUTES.includes(r) ? r : 'watches', id: x && /^[\w-]{1,80}$/.test(x) ? x : null};
}
function setHash(h, replace) { if (location.hash.slice(1) === h) return; try { if (replace) history.replaceState(null, '', '#' + h); else location.hash = h; } catch { /* fixed address */ } }
async function go(h) { setHash(h); await fromHash(true); }
async function fromHash(force) {
  const tk = linkIn(); if (tk) return openLink(tk);
  if (!S.me) return;
  const {r, id} = readHash(), want = (r === 'watch' || r === 'edit') && !id ? 'watches' : r;
  if (!force && want === S.route && id === S.id && want !== 'new') return;
  if (want === 'new' && S.route !== 'new') S.ed = null;
  S.route = want; S.id = id; closeDlg(); await render(); scrollTo(0, 0); const m = $('#main'); if (m) m.focus({preventScroll: true});
}
function linkIn() { const m = location.hash.match(/^#invite=([\w-]{20,100})[^\w-]*$/); if (!m) return null; try { history.replaceState(null, '', location.pathname + location.search); } catch { /* fixed address */ } return m[1]; }
async function openLink(token) {
  if (!S.me) { try { S.me = await api.me(); } catch { S.me = null; } }
  let info = null; try { info = await api.linkInfo(token); } catch { /* used or expired */ }
  if (!info && S.me) { await render(); return toast('That sign-in link has been used already or has expired. You are still signed in.'); }
  if (info && S.me) await api.logout().catch(() => {});
  S.me = null; S.D = {}; S.link = info ? {token, ...info} : null; S.linkBad = !info; await render(); const p = $('#lgPass'); if (p) p.focus();
}
function focusKey(el) { if (!el || el === document.body || (el.closest && el.closest('dialog'))) return ''; if (el.id) return '#' + CSS.escape(el.id); const d = el.dataset || {}; return d.act ? `[data-act="${d.act}"]` + ['id', 'v', 'p', 'i', 'c', 'r'].filter(k => d[k] != null).map(k => `[data-${k}="${CSS.escape(d[k])}"]`).join('') : d.chg && el.value != null ? `[data-chg="${d.chg}"][value="${CSS.escape(el.value)}"]` : ''; }
function applyTheme() { const r = document.documentElement; if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme); }

document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (!el || el.disabled) return; const fn = ACT[el.dataset.act]; if (fn) { e.preventDefault(); fn(el, e); } });
document.addEventListener('change', e => { const el = e.target.closest('[data-chg]'); if (el && CHG[el.dataset.chg]) CHG[el.dataset.chg](el); });
document.addEventListener('input', e => {
  const el = e.target, k = el.dataset && el.dataset.ed;
  if (k && S.ed) {
    if (k.startsWith('launch.')) S.ed.launch[k.slice(7)] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    else if (k === 'q') { S.ed.q = el.value; const m = $('.pick-l'); if (m) { const t = document.createElement('div'); t.innerHTML = picker(); m.innerHTML = t.querySelector('.pick-l').innerHTML; } return; }
    else if (k === 'name') { S.ed.name = el.value; S.ed.named = true; }
    else S.ed[k] = el.value;
    paintSide();
  }
  const f = el.closest && el.closest('form'); if (f && el.hasAttribute('aria-invalid')) clearErr(f);
});
document.addEventListener('submit', e => { const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); clearErr(f); FORMS[f.dataset.form](f); });
window.addEventListener('hashchange', () => fromHash());
dlg().addEventListener('click', e => { if (e.target === dlg()) closeDlg(); });
dlg().addEventListener('close', () => { dlg().innerHTML = ''; const b = openDlg.back && $(openDlg.back); if (b) b.focus(); });

applyTheme();
(async () => {
  const tk = linkIn(); if (tk) return openLink(tk);
  try { S.me = await api.me(); } catch { S.me = null; }
  if (!S.me) { try { S.auth = await api.authState(); } catch { /* the sign-in form is the safe default */ } return render(); }
  const {r, id} = readHash(); S.route = (r === 'watch' || r === 'edit') && !id ? 'watches' : r; S.id = id; render();
})();
