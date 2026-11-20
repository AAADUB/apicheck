// The one contract the interface talks to: the Worker's JSON API under /api.
const fail = (code, extra) => Object.assign(new Error(code), {code, ...(extra || {})});
const enc = v => encodeURIComponent(String(v));
const qs = o => Object.entries(o || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

export class Api {
  async call(method, path, body) {
    let res;
    try { res = await fetch('/api' + path, {method, credentials: 'same-origin', headers: method === 'GET' ? {} : {'content-type': 'application/json', 'x-apicheck': '1'}, body: body ? JSON.stringify(body) : undefined}); }
    catch { throw fail('offline'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const {error, ...rest} = data; throw fail(error || 'server', rest); }
    return data;
  }
  me() { return this.call('GET', '/me').catch(e => { if (e.code === 'auth') return null; throw e; }); }
  authState() { return this.call('GET', '/auth/state'); }
  login(email, password) { return this.call('POST', '/auth/login', {email, password}); }
  setup(p) { return this.call('POST', '/auth/setup', p); }
  linkInfo(token) { return this.call('POST', '/auth/invite', {token}); }
  acceptLink(token, password) { return this.call('POST', '/auth/accept', {token, password}); }
  logout() { return this.call('POST', '/auth/logout', {}); }
  updateMe(p) { return this.call('PATCH', '/me', p); }
  users() { return this.call('GET', '/admin/users'); }
  createUser(p) { return this.call('POST', '/admin/users', p); }
  newLink(id) { return this.call('POST', `/admin/users/${enc(id)}/link`, {}); }
  patchUser(id, p) { return this.call('PATCH', '/admin/users/' + enc(id), p); }
  deleteUser(id) { return this.call('DELETE', '/admin/users/' + enc(id)); }
  keys() { return this.call('GET', '/keys'); }
  addKey(p) { return this.call('POST', '/keys', p); }
  patchKey(id, p) { return this.call('PATCH', '/keys/' + enc(id), p); }
  checkKey(id) { return this.call('POST', `/keys/${enc(id)}/check`, {}); }
  deleteKey(id) { return this.call('DELETE', '/keys/' + enc(id)); }
  catalog(id, params) { return this.call('GET', `/keys/${enc(id)}/catalog` + (params && qs(params) ? '?' + qs(params) : '')); }
  watches() { return this.call('GET', '/watches'); }
  watch(id) { return this.call('GET', '/watches/' + enc(id)); }
  addWatch(p) { return this.call('POST', '/watches', p); }
  patchWatch(id, p) { return this.call('PATCH', '/watches/' + enc(id), p); }
  deleteWatch(id) { return this.call('DELETE', '/watches/' + enc(id)); }
  checkNow(id) { return this.call('POST', `/watches/${enc(id)}/check`, {}); }
  preflightWatch(id) { return this.call('POST', `/watches/${enc(id)}/preflight`, {}); }
  preflightKey(id, p) { return this.call('POST', `/keys/${enc(id)}/preflight`, p); }
  live() { return this.call('GET', '/live'); }
  events(q) { return this.call('GET', '/events?' + qs(q)); }
  launches() { return this.call('GET', '/launches'); }
  refreshLaunch(id) { return this.call('POST', `/launches/${enc(id)}/refresh`, {}); }
  forgetLaunch(id) { return this.call('DELETE', '/launches/' + enc(id)); }
  notices() { return this.call('GET', '/notices'); }
  testMail() { return this.call('POST', '/notify/test', {}); }
}
