// pCloud direkt aus der App (offizielle API). Anmeldung mit E-Mail und Passwort:
// – für fast alles ein Sitzungs-Schlüssel („auth“), den pCloud nach der Anmeldung ausgibt;
// – zum Lesen von Dateiinhalten „getzip“ mit Einmal-Anmeldung (Digest), denn getfilelink sperrt pCloud für Web-Apps (Fehler 7010).
//   Klappt getzip nicht, gibt es einen zweiten Weg über einen kurzzeitigen Freigabe-Link (getpubzip), der danach wieder gelöscht wird.
// – Lehnt pCloud den Sitzungs-Schlüssel ab (bei manchen Konten „2000 Log in failed“ trotz richtiger Anmeldung),
//   meldet sich die App bei jeder Anfrage einzeln an (Digest), wie es 2.x beim Lesen schon getan hat.

import { SourceError, offlineError, joinPath, BlobCache, mimeOf, sha1hex, xhr } from './base.js';
import { firstFileFromZip } from '../unzip.js';

const MESSAGES = {
  1000: 'Bitte bei pCloud anmelden.',
  2000: 'E-Mail oder Passwort von pCloud stimmt nicht.',
  2297: 'Bei pCloud ist die Zwei-Faktor-Anmeldung an. Das kann die App noch nicht – bitte Bescheid geben, dann wird es nachgerüstet.',
  2003: 'Dafür fehlt die Berechtigung.',
  2004: 'Hier gibt es schon etwas mit diesem Namen.',
  2005: 'Der Ordner wurde nicht gefunden.',
  2009: 'Die Datei wurde nicht gefunden.',
  2008: 'Dein pCloud-Speicher ist voll.',
  2001: 'Der Name ist ungültig.',
  2023: 'Ein Ordner kann nicht in sich selbst kopiert oder verschoben werden.',
  4000: 'Zu viele Anmeldeversuche. Bitte ein paar Minuten warten.',
  5000: 'pCloud ist gerade nicht erreichbar. Bitte später noch einmal.',
  7010: 'pCloud lässt diese Datei im Browser nicht direkt öffnen.',
};
const LOGIN_CODES = [1000, 2000, 2094, 2095, 2297, 4000];

function perr(method, code, text) {
  return new SourceError(MESSAGES[code] || text || 'Fehler bei pCloud', {
    code, detail: `pCloud ${method}: ${code} ${text || ''}`.trim(), login: LOGIN_CODES.includes(code), notFound: [2002, 2005, 2009, 2055].includes(code),
  });
}

function toItem(m, folder) {
  return {
    name: m.name, isFolder: !!m.isfolder, size: m.size || 0, mtime: Date.parse(m.modified) || 0,
    id: m.isfolder ? m.folderid : m.fileid, fileid: m.fileid, folderid: m.folderid,
    thumb: !!m.thumb, mime: m.contenttype || '', path: joinPath(folder, m.name),
  };
}

export class PCloudSource {
  static type = 'pcloud';

  /** conn: { cfg: { host } }, secret: { user, pass } */
  constructor(conn, secret) {
    this.host = conn?.cfg?.host || 'api.pcloud.com';
    this.user = secret?.user || '';
    this.pass = secret?.pass || '';
    this.auth = null;
    this.digest = null;
    this.useDigest = false;   // true: Sitzungs-Schlüssel geht nicht, jede Anfrage einzeln anmelden
    this.blobs = new BlobCache(6);
  }

  // ---------------------------------------------------------------- Anmeldung

  async _getJson(url, method) {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch { throw offlineError(); }
    if (!res.ok) throw perr(method, 5000, 'HTTP ' + res.status);
    return res.json();
  }

  /** Einmal-Anmeldung für genau eine Anfrage (der Digest gilt bei pCloud etwa 30 Sekunden). */
  async _signed() {
    if (!this.digest || Date.now() - this.digest.at > 20000) {
      const d = await this._getJson(`https://${this.host}/getdigest`, 'getdigest');
      if (d.result !== 0) throw perr('getdigest', d.result, d.error);
      this.digest = { value: d.digest, at: Date.now() };
    }
    const passworddigest = await sha1hex(this.pass + await sha1hex(this.user.toLowerCase()) + this.digest.value);
    return { username: this.user, digest: this.digest.value, passworddigest };
  }

  /** Frischer Digest nur für diese eine Anfrage. */
  async _signedFresh() { this.digest = null; return this._signed(); }

  /** Anmelde-Angaben für eine Anfrage: Sitzungs-Schlüssel oder einzeln angemeldet. */
  async _cred() {
    if (!this.useDigest && !this.auth) await this.login();
    return this.useDigest ? this._signedFresh() : { auth: this.auth };
  }

  _url(method, params) { return `https://${this.host}/${method}?${new URLSearchParams(params)}`; }

  async login() {
    let j = await this._getJson(this._url('userinfo', { getauth: 1, ...(await this._signed()) }), 'userinfo');
    if (j.result !== 0 && ![2297, 4000].includes(j.result)) {
      // Konten in Europa liegen bei eapi.pcloud.com, andere bei api.pcloud.com – den anderen Server versuchen
      const other = this.host === 'eapi.pcloud.com' ? 'api.pcloud.com' : 'eapi.pcloud.com';
      const keep = this.host;
      this.host = other; this.digest = null;
      const j2 = await this._getJson(this._url('userinfo', { getauth: 1, ...(await this._signed()) }), 'userinfo').catch(() => null);
      if (j2?.result === 0) { j = j2; this.cfgUpdate = { host: other }; } else { this.host = keep; this.digest = null; }
    }
    if (j.result !== 0) throw perr('userinfo', j.result, j.error);
    this.auth = j.auth || null;
    if (!this.auth) this.useDigest = true;
    this.me = { email: j.email, used: j.usedquota, total: j.quota, key: 'pcloud:' + j.userid };
    return this.me;
  }

  async api(method, params = {}, { body, signal, retried = 0 } = {}) {
    const cred = await this._cred();
    let res;
    try {
      res = await fetch(this._url(method, { ...params, ...cred }), body ? { method: 'POST', body, signal } : { signal, cache: 'no-store' });
    } catch (e) { if (e.name === 'AbortError') throw e; throw offlineError(); }
    if (!res.ok) throw perr(method, 5000, 'HTTP ' + res.status);
    const j = await res.json();
    if ((j.result === 1000 || j.result === 2000) && retried < 2) {
      // 1. Versuch: neuer Sitzungs-Schlüssel. 2. Versuch: ohne Schlüssel, jede Anfrage einzeln anmelden.
      if (cred.auth && retried === 0) this.auth = null;
      else if (!this.useDigest) { this.useDigest = true; this.authFailed = `pCloud ${method}: ${j.result} ${j.error || ''}`.trim(); }
      else return this._fail(method, j);
      return this.api(method, params, { body, signal, retried: retried + 1 });
    }
    if (j.result !== 0) return this._fail(method, j);
    return j;
  }

  _fail(method, j) {
    const e = perr(method, j.result, j.error);
    if (this.authFailed && e.login) e.detail += ' · vorher ' + this.authFailed;
    throw e;
  }

  async info() {
    if (this.me && Date.now() - (this.meAt || 0) < 60000) return this.me;
    if (!this.auth) await this.login();
    else { const j = await this.api('userinfo'); this.me = { email: j.email, used: j.usedquota, total: j.quota, key: 'pcloud:' + j.userid }; }
    this.meAt = Date.now();
    return this.me;
  }

  // ---------------------------------------------------------------- Lesen

  async list(path) {
    const j = await this.api('listfolder', { path: path || '/' });
    return (j.metadata.contents || []).map((m) => toItem(m, path || '/'));
  }

  async search(path, q) {
    const j = await this.api('listfolder', { path: path || '/', recursive: 1 });
    const out = [];
    const needle = q.toLowerCase();
    const walk = (m, p) => { for (const c of m.contents || []) { const it = toItem(c, p); if (it.name.toLowerCase().includes(needle)) out.push(it); if (c.isfolder) walk(c, it.path); } };
    walk(j.metadata, path || '/');
    return out;
  }

  async _fileid(item) {
    if (item.fileid) return item.fileid;
    return (await this.api('stat', { path: item.path })).metadata.fileid;
  }

  /** Dateiinhalt als Bytes. Erst getzip, sonst über einen kurzen Freigabe-Link. Bei Fehlern mit genauer Angabe, was pCloud gemeldet hat. */
  async bytes(item) {
    const fileid = await this._fileid(item);
    let first;
    try { return await this._zip(this._url('getzip', { fileids: fileid, filename: 'datei.zip', ...(await this._signed()) }), 'getzip'); }
    catch (e) { if (e.offline || e.login) throw e; first = e; }
    // Zweiter Weg: Freigabe-Link anlegen, als ZIP holen (ohne Anmeldung), Link sofort wieder löschen
    let link = null;
    try {
      link = await this.api('getfilepublink', { fileid });
      return await this._zip(`https://${this.host}/getpubzip?${new URLSearchParams({ code: link.code, filename: 'datei.zip' })}`, 'getpubzip');
    } catch (e) {
      if (e.offline) throw e;
      throw new SourceError('pCloud gibt die Datei nicht heraus.', { code: e.code, detail: [first?.detail, e.detail || e.message].filter(Boolean).join(' · ') });
    } finally {
      if (link?.linkid) this.api('deletepublink', { linkid: link.linkid }).catch(() => {});
    }
  }

  async _zip(url, method) {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch { throw offlineError(); }
    if (!res.ok) throw perr(method, 5000, 'HTTP ' + res.status);
    if ((res.headers.get('content-type') || '').includes('json')) { const j = await res.json(); throw perr(method, j.result, j.error); }
    try { return await firstFileFromZip(new Uint8Array(await res.arrayBuffer())); }
    catch (e) { throw new SourceError(e.message, { detail: `pCloud ${method}: kein gültiges ZIP` }); }
  }

  async blob(item) { return new Blob([await this.bytes(item)], { type: item.mime || mimeOf(item.name) }); }

  async mediaUrl(item) {
    const k = item.fileid || item.path;
    return this.blobs.get(k) || this.blobs.set(k, URL.createObjectURL(await this.blob(item)));
  }

  thumbUrl(item, size = 'm') {
    if (!item.thumb || !item.fileid) return null;
    const params = { fileid: item.fileid, size: size === 'l' ? '1024x1024' : '256x256', crop: size === 'l' ? 0 : 1 };
    if (!this.useDigest && this.auth) return this._url('getthumb', { ...params, auth: this.auth });
    if (!this.useDigest) return null;
    // Ohne Sitzungs-Schlüssel: Vorschaubild einzeln angemeldet holen und als lokale Adresse zeigen
    const k = 'thumb:' + size + ':' + item.fileid;
    if (this.blobs.get(k)) return this.blobs.get(k);
    return (async () => {
      const res = await fetch(this._url('getthumb', { ...params, ...(await this._signedFresh()) }));
      if (!res.ok || (res.headers.get('content-type') || '').includes('json')) return null;
      return this.blobs.get(k) || this.blobs.set(k, URL.createObjectURL(await res.blob()));
    })().catch(() => null);
  }

  async checksum(item) {
    const j = await this.api('checksumfile', { fileid: await this._fileid(item) });
    return j.sha256 ? { algo: 'SHA-256', hex: j.sha256.toLowerCase() } : { algo: 'SHA-1', hex: (j.sha1 || '').toLowerCase() };
  }

  async readText(path) {
    try { await this.api('stat', { path }); } catch (e) { if (e.notFound) return null; throw e; }
    return new TextDecoder().decode(await this.bytes({ path }));
  }

  // ---------------------------------------------------------------- Ändern

  async _folderid(path) { return path === '/' ? 0 : (await this.api('listfolder', { path, nofiles: 1 })).metadata.folderid; }

  async mkdir(parent, name) { await this.api('createfolder', { path: joinPath(parent, name) }); }

  rename(item, name) {
    return item.isFolder ? this.api('renamefolder', { folderid: item.folderid ?? item.id, toname: name }) : this.api('renamefile', { fileid: item.fileid ?? item.id, toname: name });
  }

  async move(item, toFolder, name = item.name) {
    const tofolderid = await this._folderid(toFolder);
    return item.isFolder ? this.api('renamefolder', { folderid: item.folderid, tofolderid, toname: name }) : this.api('renamefile', { fileid: item.fileid, tofolderid, toname: name });
  }

  async copy(item, toFolder, name = item.name) {
    const tofolderid = await this._folderid(toFolder);
    if (item.isFolder) {
      if (name === item.name) return this.api('copyfolder', { folderid: item.folderid, tofolderid, noover: 1 });
      // Ordner unter anderem Namen: erst Zielordner anlegen, dann den Inhalt hineinkopieren
      const made = await this.api('createfolder', { folderid: tofolderid, name });
      return this.api('copyfolder', { folderid: item.folderid, tofolderid: made.metadata.folderid, noover: 1, copycontentonly: 1 });
    }
    return this.api('copyfile', { fileid: item.fileid, tofolderid, toname: name, noover: 1 });
  }

  remove(item) {
    return item.isFolder ? this.api('deletefolderrecursive', { folderid: item.folderid ?? item.id }) : this.api('deletefile', { fileid: item.fileid ?? item.id });
  }

  async shareLink(item) {
    const j = item.isFolder ? await this.api('getfolderpublink', { folderid: item.folderid }) : await this.api('getfilepublink', { fileid: item.fileid });
    return j.link;
  }

  async writeText(path, text) {
    const i = path.lastIndexOf('/');
    const folder = path.slice(0, i) || '/';
    await this.api('createfolderifnotexists', { path: folder });
    const fd = new FormData();
    fd.append('file', new Blob([text], { type: 'application/json' }), path.slice(i + 1));
    await this.api('uploadfile', { path: folder, filename: path.slice(i + 1), nopartial: 1 }, { body: fd });
  }

  /** Hochladen; große Dateien in Teilen (bei Abbruch geht es an der Stelle weiter, state wird fortgeschrieben). */
  async upload(file, folder, name, { onProgress, signal, state = {} } = {}) {
    const CHUNK = 8 * 1024 * 1024;
    const folderid = state.folderid ?? (state.folderid = await this._folderid(folder));
    const call = async (method, params, body, base = 0) => {
      const r = await xhr('POST', this._url(method, { ...params, ...(await this._cred()) }), body, { signal, onProgress: (n) => onProgress && onProgress(base + n) });
      const j = r.body;
      if (r.status !== 200 || !j) throw perr(method, 5000, 'HTTP ' + r.status);
      if (j.result !== 0) throw perr(method, j.result, j.error);
      return j;
    };
    if (file.size <= 2 * CHUNK || state.single) {
      const fd = new FormData();
      fd.append('file', file, name);
      const j = await call('uploadfile', { folderid, nopartial: 1, filename: name }, fd);
      return j.metadata?.[0];
    }
    try {
      if (!state.uploadid) { state.uploadid = (await this.api('upload_create', {}, { signal })).uploadid; state.offset = 0; }
      else state.offset = (await this.api('upload_info', { uploadid: state.uploadid }, { signal })).size;
      while (state.offset < file.size) {
        if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
        const end = Math.min(file.size, state.offset + CHUNK);
        await call('upload_write', { uploadid: state.uploadid, uploadoffset: state.offset }, new Blob([file.slice(state.offset, end)], { type: 'text/plain' }), state.offset);
        state.offset = end;
        onProgress && onProgress(state.offset);
      }
      return (await this.api('upload_save', { uploadid: state.uploadid, folderid, name }, { signal })).metadata;
    } catch (e) {
      if (e instanceof SourceError && !e.login && state.offset === 0 && !state.single) { state.single = true; state.uploadid = null; return this.upload(file, folder, name, { onProgress, signal, state }); }
      throw e;
    }
  }
}
