'use strict';

// ============================================================
//  Astra Browser - Electron main process
//  - `--dosid <url>` ile gelince: dosid cookie'sini ekleyip backpage'i acar.
//  - Parametresiz acilinca: normal tarayici penceresi; hesaplara ust menu'den gidilir.
//  - Kayitli bir hesap secilince OTOMATIK GIRIS yapilir.
//  - HER PENCERE kendi IZOLE ve GECICI oturumu ile acilir (cookie karismaz).
//
//  Kullanim:
//    "Astra Browser.exe" --dosid "https://int1.darkorbit.com/indexInternal.es?dosid=XXXX"
//    "Astra Browser.exe" --dosid XXXX --url "https://int1.darkorbit.com/indexInternal.es?action=internalStart"
//    "Astra Browser.exe" --instance int1 --dosid XXXX
//    "Astra Browser.exe"                 (hesap yoneticisini acar)
//    "Astra Browser.exe" --selftest
// ============================================================

const { app, BrowserWindow, session, Menu, MenuItem, clipboard, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const nodeNet = require('net');

const accounts = require('./accounts');
const { attachAutoLogin } = require('./login');

const APP_NAME = 'Astra Browser';

// Desteklenen arayuz/oyun dilleri. Electron'da navigator.language ve
// Accept-Language bu koddan turetilir.
const LANGUAGES = [
  { code: 'en', label: 'English', locale: 'en-US' },
  { code: 'de', label: 'Deutsch', locale: 'de-DE' },
  { code: 'es', label: 'Espanol', locale: 'es-ES' },
  { code: 'fr', label: 'Francais', locale: 'fr-FR' },
  { code: 'it', label: 'Italiano', locale: 'it-IT' },
  { code: 'pl', label: 'Polski', locale: 'pl-PL' },
  { code: 'pt', label: 'Portugues', locale: 'pt-PT' },
  { code: 'ro', label: 'Romana', locale: 'ro-RO' },
  { code: 'ru', label: 'Russkiy', locale: 'ru-RU' },
  { code: 'tr', label: 'Turkce', locale: 'tr-TR' },
  { code: 'cs', label: 'Cestina', locale: 'cs-CZ' },
  { code: 'hu', label: 'Magyar', locale: 'hu-HU' },
  { code: 'nl', label: 'Nederlands', locale: 'nl-NL' },
  { code: 'bg', label: 'Balgarski', locale: 'bg-BG' },
  { code: 'el', label: 'Ellinika', locale: 'el-GR' }
];

// Pencere/gorev cubugu ikonu (resources\app\icon.png = astra2.png)
const ICON_PATH = path.join(__dirname, 'icon.png');

// Gorev cubugunda dogru ikon/isim gruplamasi icin
try { app.setAppUserModelId('Astra Browser'); } catch (e) { /* ignore */ }

// Backpage'in Flash surumu yalnizca bu UA ile servis edilir (bot ile ayni).
const FALLBACK_UA = 'BigpointClient/1.6.9';

function rid() {
  return crypto.randomBytes(6).toString('hex');
}

// Her surec kendi izole gecici veri klasorunu kullanir (cerez/cache cakismasi olmaz).
try {
  const userDataDir = path.join(app.getPath('temp'), 'astra-browser', rid());
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
} catch (e) { /* ignore */ }

function parseArgs(argv) {
  const out = {
    dosid: null, url: null, instance: null, selftest: false,
    captcha: false, client: null, resultFile: null, timeout: 120000,
    width: 430, height: 650, lang: null,
    proxyHost: null, proxyPort: null, proxyUser: null, proxyPass: null, proxyType: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      out.selftest = true;
      continue;
    }
    if (a === '--captcha') {
      out.captcha = true;
      continue;
    }
    let key = a;
    let val = null;
    const eq = a.indexOf('=');
    if (a.indexOf('--') === 0 && eq > 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    const take = () => (val !== null ? val : argv[++i]);
    if (key === '--dosid') out.dosid = take();
    else if (key === '--url') out.url = take();
    else if (key === '--instance') out.instance = take();
    else if (key === '--client') out.client = take();
    else if (key === '--result-file') out.resultFile = take();
    else if (key === '--timeout') out.timeout = parseInt(take(), 10) || 120000;
    else if (key === '--width') out.width = parseInt(take(), 10) || 430;
    else if (key === '--height') out.height = parseInt(take(), 10) || 650;
    else if (key === '--proxy-host') out.proxyHost = take();
    else if (key === '--proxy-port') out.proxyPort = take();
    else if (key === '--proxy-user') out.proxyUser = take();
    else if (key === '--proxy-pass') out.proxyPass = take();
    else if (key === '--proxy-type') out.proxyType = take();
    else if (key === '--lang') out.lang = (take() || '').toLowerCase();
  }
  return out;
}

function findFlash() {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', 'flash', 'pepflashplayer.dll'),
    path.join(appPath, 'flash', 'pepflashplayer.dll')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.normalize(c);
  }
  return path.normalize(candidates[0]);
}

function resolveTarget(args) {
  const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
  let sid = null;
  let origin = null;
  let targetUrl = null;

  if (args.dosid && isUrl(args.dosid)) {
    try {
      const u = new URL(args.dosid);
      origin = u.origin;
      sid = u.searchParams.get('dosid') || u.searchParams.get('sid');
      targetUrl = origin + '/indexInternal.es?action=internalStart';
    } catch (e) { /* ignore */ }
  } else if (args.dosid) {
    sid = args.dosid;
    if (args.url) {
      try { origin = new URL(args.url).origin; } catch (e) { /* ignore */ }
      targetUrl = args.url;
    } else if (args.instance) {
      origin = 'https://' + args.instance + '.darkorbit.com';
      targetUrl = origin + '/indexInternal.es?action=internalStart';
    } else {
      targetUrl = 'https://www.darkorbit.com/';
    }
  } else if (args.url) {
    try { origin = new URL(args.url).origin; } catch (e) { /* ignore */ }
    targetUrl = args.url;
  } else {
    targetUrl = 'https://www.darkorbit.com/';
  }
  return { sid, origin, targetUrl };
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// Verilen oturumun (proxy dahil) cikis IP'sini dondurur.
// Captcha IP'ye bagli geldigi icin Astra'nin bot ile AYNI IP'den ciktigini dogrular.
function egressIP(ses, proxyUser, proxyPass) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'GET', url: 'https://api.ipify.org', session: ses });
      let body = '';
      // Proxy kimlik dogrulamasi net.request icin ayri event.
      req.on('login', (authInfo, callback) => callback(proxyUser || '', proxyPass || ''));
      req.on('response', (res) => {
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => resolve(body.trim()));
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.end();
    } catch (e) {
      resolve('');
    }
  });
}

// ---- Yerel tunel proxy'si ----
// Bu proxy ayni anda az sayida CONNECT tuneline izin verir; fazlasina
// "HTTP/1.1 429 Too Many Requests" doner. Chromium bunu ERR_TUNNEL_CONNECTION_FAILED
// olarak gorur ve sayfa yarim yuklenir (jQuery/hCaptcha gibi kritik dosyalar gelmez).
// Bu yuzden Chromium'u kendi yerel proxy'mize baglariz; yerel proxy 429 alirsa
// bekleyip tekrar dener ve bos bekleyen tunelleri kapatarak yer acar.
function startThrottleProxy(opts) {
  const upHost = opts.host;
  const upPort = Number(opts.port);
  const user = opts.user || '';
  const pass = opts.pass || '';
  // Bosta bekleyen tunel bu sure sonunda kapatilir; aksi halde Chromium'un
  // keep-alive baglantilari proxy'nin tunel limitini tikar ve sayfa donar.
  const idleMs = Math.max(2000, Number(opts.idleMs) || 8000);
  const auth = (user || pass)
    ? 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
    : '';

  const splitHostPort = (s) => {
    const i = String(s).lastIndexOf(':');
    if (i < 0) return [String(s), 443];
    return [s.slice(0, i), Number(s.slice(i + 1)) || 443];
  };

  // Upstream'e CONNECT acar; 429/hata durumunda bekleyip tekrar dener.
  const openTunnel = (tHost, tPort, onTunnel, onFail) => {
    const attempt = (n) => {
      const up = nodeNet.connect(upPort, upHost, () => {
        const lines = [
          'CONNECT ' + tHost + ':' + tPort + ' HTTP/1.1',
          'Host: ' + tHost + ':' + tPort
        ];
        if (auth) lines.push('Proxy-Authorization: ' + auth);
        up.write(lines.join('\r\n') + '\r\n\r\n');
      });
      let buf = Buffer.alloc(0);
      let settled = false;
      const retry = (code) => {
        if (settled) return;
        settled = true;
        try { up.destroy(); } catch (e) { /* ignore */ }
        const retriable = code === undefined || code === 0 || code === 429 || code === 408 || code >= 500;
        if (!retriable || n >= 10) { onFail(); return; }
        setTimeout(() => attempt(n + 1), 300 + n * 400);
      };
      up.setTimeout(25000, () => retry(0));
      up.on('error', () => retry(0));
      up.on('data', (chunk) => {
        if (settled) return;
        buf = Buffer.concat([buf, chunk]);
        const hdrEnd = buf.indexOf('\r\n\r\n');
        if (hdrEnd < 0) { if (buf.length > 16384) retry(0); return; }
        const hdr = buf.slice(0, hdrEnd).toString('latin1');
        const rest = buf.slice(hdrEnd + 4);
        const code = parseInt((hdr.match(/^HTTP\/1\.[01] (\d+)/) || [])[1] || '0', 10);
        if (code !== 200) { retry(code); return; }
        settled = true;
        up.setTimeout(0);
        up.removeAllListeners('data');
        up.removeAllListeners('error');
        onTunnel(up, rest);
      });
    };
    attempt(0);
  };

  const server = http.createServer((req, res) => {
    const attempt = (n) => {
      const headers = Object.assign({}, req.headers);
      if (auth) headers['Proxy-Authorization'] = auth;
      const up = http.request({
        host: upHost, port: upPort, method: req.method, path: req.url, headers
      }, (upRes) => {
        const code = upRes.statusCode || 0;
        if ((code === 429 || code >= 500) && n < 10) {
          upRes.resume();
          setTimeout(() => attempt(n + 1), 300 + n * 400);
          return;
        }
        res.writeHead(code, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', () => {
        try { up.destroy(); } catch (e) { /* ignore */ }
        if (n < 10) setTimeout(() => attempt(n + 1), 300 + n * 400);
        else { try { res.destroy(); } catch (e) { /* ignore */ } }
      });
      if (n === 0) req.pipe(up); else up.end();
    };
    attempt(0);
  });

  // Tunel bosta kalirsa kapat: Chromium gerektiginde yeniden acar.
  const keepAliveWatch = (clientSocket, up) => {
    let timer = null;
    const touch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { up.destroy(); } catch (e) { /* ignore */ }
        try { clientSocket.destroy(); } catch (e) { /* ignore */ }
      }, idleMs);
    };
    clientSocket.on('data', touch);
    up.on('data', touch);
    touch();
  };

  server.on('connect', (req, clientSocket, head) => {
    const [tHost, tPort] = splitHostPort(req.url);
    let closed = false;
    clientSocket.on('error', () => { /* ignore */ });
    clientSocket.on('close', () => { closed = true; });
    openTunnel(tHost, tPort, (up, rest) => {
      if (closed) { try { up.destroy(); } catch (e) { /* ignore */ } return; }
      try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (e) { /* ignore */ }
      if (rest && rest.length) { try { clientSocket.write(rest); } catch (e) { /* ignore */ } }
      if (head && head.length) { try { up.write(head); } catch (e) { /* ignore */ } }
      up.pipe(clientSocket);
      clientSocket.pipe(up);
      keepAliveWatch(clientSocket, up);
      up.on('close', () => { try { clientSocket.destroy(); } catch (e) { /* ignore */ } });
      up.on('error', () => { try { clientSocket.destroy(); } catch (e) { /* ignore */ } });
    }, () => {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) { /* ignore */ }
    });
  });

  return new Promise((resolve) => {
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => { try { server.close(); } catch (e) { /* ignore */ } }
      });
    });
  });
}

// Captcha penceresinde reklam/izleme isteklerini engeller: proxy'nin sinirli
// tunel sayisini gereksiz yere tuketmesinler (asil istekler 429 alip kayboluyordu).
const CAPTCHA_BLOCK_HOSTS = [
  'googletagmanager.com', 'googletagservices.com', 'google-analytics.com',
  'googlesyndication.com', 'googleadservices.com', 'doubleclick.net',
  'bat.bing.com', 'clarity.ms', 'quantserve.com', 'scorecardresearch.com',
  'cmp.inmobi.com', 'inmobi.com', 'adnxs.com', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'moatads.com', 'adsafeprotected.com',
  'hotjar.com', 'yieldmo.com', 'rubiconproject.com', 'pubmatic.com',
  'smartadserver.com', 'facebook.net', 'connect.facebook.net'
];

function installCaptchaFilters(ses, diagDir) {
  const logFile = diagDir ? path.join(diagDir, 'captcha_net.log') : '';
  const log = (line) => {
    if (!logFile) return;
    try { fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* ignore */ }
  };
  try {
    ses.webRequest.onBeforeRequest((details, callback) => {
      let host = '';
      try { host = new URL(details.url).hostname.toLowerCase(); } catch (e) { host = ''; }
      const blocked = !!host && CAPTCHA_BLOCK_HOSTS.some((h) => host === h || host.endsWith('.' + h));
      log((blocked ? 'BLOCK ' : 'REQ ') + details.url);
      callback({ cancel: blocked });
    });
    ses.webRequest.onCompleted((d) => log('DONE ' + d.statusCode + ' ' + d.url));
    ses.webRequest.onErrorOccurred((d) => log('ERR ' + d.error + ' ' + d.url));
  } catch (e) { /* ignore */ }
}

let managerWindow = null;
let activeBrowserWindow = null;

// Secili dil: --lang > ASTRA_LANG > settings.json
let language = null;

function resolveLanguage() {
  let code = '';
  try {
    const a = process.argv.slice(1);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--lang' && a[i + 1]) { code = a[i + 1]; break; }
      if (a[i].indexOf('--lang=') === 0) { code = a[i].slice(7); break; }
    }
  } catch (e) { /* ignore */ }
  if (!code && process.env.ASTRA_LANG) code = process.env.ASTRA_LANG;
  if (!code) {
    try { code = readSettings().language || ''; } catch (e) { code = ''; }
  }
  code = String(code || '').toLowerCase().slice(0, 2);
  if (!code || code === 'sy') return null;
  return LANGUAGES.find((l) => l.code === code) || null;
}

// Her oturumda Accept-Language'i sabitler; navigator.language icin --lang yeterli.
function applyLanguageToSession(ses) {
  if (!language) return;
  const header = language.locale + ',' + language.code + ';q=0.9,en;q=0.8';
  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders || {};
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'accept-language') delete headers[key];
      }
      headers['Accept-Language'] = header;
      callback({ requestHeaders: headers });
    });
  } catch (e) { /* ignore */ }
}

// DarkOrbit sayfa dilini Accept-Language degil, ".darkorbit.com" uzerindeki
// "lang" cerezi belirliyor; her oturumda o cerezi aciyoruz.
function applyLanguageCookie(ses) {
  if (!language) return Promise.resolve();
  try {
    return ses.cookies.set({
      url: 'https://www.darkorbit.com/',
      name: 'lang',
      value: language.code,
      domain: '.darkorbit.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 31536000
    }).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

function prepareLanguageSession(ses) {
  applyLanguageToSession(ses);
  return applyLanguageCookie(ses);
}

// ---- Tanilama (yalnizca ASTRA_DIAG_DIR verildiginde) ----
const DIAG_DIR = process.env.ASTRA_DIAG_DIR || '';

let DIAG_SEQ = 0;

function diagWrite(rel, text) {
  if (!DIAG_DIR) return;
  try {
    const p = path.join(DIAG_DIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  } catch (e) { /* ignore */ }
}

function diagSafe(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function diagNote(win, note) {
  try { win.__diag.notes.push(new Date().toISOString() + ' ' + note); } catch (e) { /* ignore */ }
}

// Backpage HTML'i sunucudan "tr" olarak geliyor (ulke sunuculari). Istemci dilini
// bu HTML'deki flashvar belirledigi icin yanit govdesini CDP ile yeniden yaziyoruz:
//   "lang":"tr"  ->  "lang":"de"
// ASTRA_DIAG_DIR set ise ayni gecis noktasindan tanilama dosyalari da yazilir.
function installBackpageHook(win) {
  if (!language && !DIAG_DIR) return;
  win.__diag = win.__diag || { seq: 0, net: [], netById: {}, console: [], notes: [], page: 0 };
  const dbg = win.webContents.debugger;
  let attached = false;

  const enable = () => {
    if (attached) return;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      attached = true;
    } catch (e) {
      diagNote(win, 'debugger attach failed: ' + e.message);
      return;
    }
    if (DIAG_DIR) {
      dbg.sendCommand('Network.enable', {}).catch(() => {});
      if (language) diagNote(win, 'language rewrite active: ' + language.code);
    }
    dbg.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*indexInternal.es*', requestStage: 'Response' }]
    }).catch(() => {});
  };

  dbg.on('message', async (event, method, params) => {
    if (DIAG_DIR) {
      try { collectNetwork(win, method, params, dbg); } catch (e) { /* ignore */ }
    }
    if (method !== 'Fetch.requestPaused') return;
    const id = params.requestId;
    const url = params.request ? params.request.url : '';
    if (!params.responseStatusCode || !/indexInternal\.es/i.test(url)) {
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e) { /* ignore */ }
      return;
    }
    const ctype = (params.responseHeaders || [])
      .filter((h) => h.name.toLowerCase() === 'content-type')
      .map((h) => String(h.value || '').toLowerCase())
      .join(';');
    if (ctype && ctype.indexOf('text/html') < 0) {
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e) { /* ignore */ }
      return;
    }
    try {
      const bodyRes = await dbg.sendCommand('Fetch.getResponseBody', { requestId: id });
      let body = bodyRes.base64Encoded
        ? Buffer.from(bodyRes.body, 'base64').toString('binary')
        : bodyRes.body;

      if (DIAG_DIR) {
        const n = ++DIAG_SEQ;
        diagWrite('responses/' + n + '_' + diagSafe((url.split('?')[1] || 'resp')) + '.html', body);
        const langs = [];
        const re = /"(?:lang|language|langCode|locale)"\s*:\s*"([^"]{1,12})"/g;
        let m;
        while ((m = re.exec(body)) !== null) langs.push(m[0]);
        diagWrite('responses/' + n + '_lang-fields.txt',
          'url=' + url + '\ncontentType=' + ctype + '\nlength=' + body.length +
          '\nlangFields=' + JSON.stringify(langs) + '\n');
      }

      if (!language) {
        try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e) { /* ignore */ }
        return;
      }

      let changed = false;
      body = body.replace(/("(?:lang|language|langCode|locale)"\s*:\s*")([a-zA-Z_]{2,5})(")/g, (mm, a, v, b) => {
        if (v.toLowerCase() === language.code) return mm;
        changed = true;
        return a + language.code + b;
      });
      if (DIAG_DIR) diagNote(win, 'backpage body ' + (changed ? 'REWRITTEN to ' + language.code : 'unchanged') + ' (' + url + ')');
      if (!changed) {
        try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e) { /* ignore */ }
        return;
      }
      const headers = (params.responseHeaders || []).filter((h) => {
        const n = h.name.toLowerCase();
        return n !== 'content-length' && n !== 'content-encoding' && n !== 'transfer-encoding';
      });
      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId: id,
        responseCode: params.responseStatusCode,
        responseHeaders: headers,
        body: Buffer.from(body, 'binary').toString('base64')
      });
    } catch (e) {
      diagNote(win, 'fetch handler error: ' + e.message);
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e2) { /* ignore */ }
    }
  });

  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    try {
      win.__diag.console.push({ level, message, line, sourceId });
    } catch (e) { /* ignore */ }
  });

  const dumpPage = async () => {
    if (!DIAG_DIR) return;
    try {
      const data = await win.webContents.executeJavaScript(`(function(){
        var html = document.documentElement ? document.documentElement.outerHTML : '';
        var embeds = [];
        try {
          var n = document.querySelectorAll('object, embed');
          for (var i = 0; i < n.length; i++) embeds.push(n[i].outerHTML);
        } catch (e) {}
        var flashCalls = [];
        try {
          var idx = 0;
          while ((idx = html.indexOf('flashembed(', idx)) >= 0 && flashCalls.length < 5) {
            flashCalls.push(html.substr(idx, 1200));
            idx += 11;
          }
        } catch (e) {}
        var swfCalls = [];
        try {
          var j = 0;
          while ((j = html.indexOf('embedSWF', j)) >= 0 && swfCalls.length < 5) {
            swfCalls.push(html.substr(Math.max(0, j - 200), 1200));
            j += 8;
          }
        } catch (e) {}
        var up = null;
        try { up = (window.User && window.User.Parameters) ? JSON.stringify(window.User.Parameters) : null; } catch (e) {}
        return {
          url: location.href,
          title: document.title,
          html: html,
          embeds: embeds,
          flashCalls: flashCalls,
          swfCalls: swfCalls,
          userParameters: up,
          navigatorLanguage: navigator.language,
          navigatorLanguages: (navigator.languages || []).join(','),
          cookie: document.cookie,
          astraLang: window.__ASTRA_LANG || null
        };
      })();`, true);

      const n = ++DIAG_SEQ;
      const host = diagSafe((data.url || '').split('//')[1] || 'page').split('/')[0];
      diagWrite('pages/' + n + '_' + host + '_full.html', data.html || '');
      const summary = Object.assign({}, data);
      delete summary.html;
      diagWrite('pages/' + n + '_' + host + '_summary.json', JSON.stringify(summary, null, 2));

      try {
        const cookies = await win.webContents.session.cookies.get({});
        const relevant = cookies.filter((c) => /darkorbit|bpsecure/i.test(c.domain || ''));
        diagWrite('pages/' + n + '_' + host + '_cookies.json', JSON.stringify(relevant, null, 2));
      } catch (e) { /* ignore */ }
    } catch (e) {
      diagNote(win, 'dumpPage failed: ' + e.message);
    }
  };

  win.webContents.on('did-start-navigation', (e, u, inPlace, isMainFrame) => {
    if (isMainFrame) enable();
  });
  win.webContents.on('dom-ready', enable);
  win.webContents.on('did-finish-load', async () => {
    await dumpPage();
    if (DIAG_DIR) {
      diagWrite('summary_' + Date.now() + '.json', JSON.stringify({
        language: language ? language.code : null,
        notes: win.__diag.notes,
        requests: win.__diag.net,
        console: win.__diag.console
      }, null, 2));
    }
    try {
      if (dbg.isAttached()) {
        dbg.sendCommand('Fetch.disable').catch(() => {});
        dbg.sendCommand('Network.disable').catch(() => {});
        dbg.detach();
      }
    } catch (e) { /* ignore */ }
    attached = false; // sonraki navigasyonda yeniden baglan
  });
  enable();
}

// Tanilama icin ag trafigini topla (yalnizca metin govdeleri).
function collectNetwork(win, method, params, dbg) {
  const d = win.__diag;
  if (method === 'Network.requestWillBeSent') {
    d.netById[params.requestId] = {
      url: params.request.url,
      method: params.request.method,
      type: params.type,
      status: null,
      mimeType: null,
      fromCache: false,
      encodedLength: null
    };
    return;
  }
  if (method === 'Network.responseReceived') {
    const e = d.netById[params.requestId];
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
      e.fromCache = params.response.fromDiskCache || params.response.fromMemoryCache || false;
      e.headers = params.response.headers;
      d.net.push(e);
    }
    return;
  }
  if (method === 'Network.loadingFinished') {
    const e = d.netById[params.requestId];
    if (!e) return;
    e.encodedLength = params.encodedDataLength;
    const mt = String(e.mimeType || '').toLowerCase();
    const texty = mt.indexOf('xml') >= 0 || mt.indexOf('json') >= 0 ||
      mt.indexOf('javascript') >= 0 || mt.indexOf('html') >= 0 || mt.indexOf('text/plain') >= 0;
    if (texty && params.encodedDataLength < 4 * 1024 * 1024) {
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((r) => {
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        diagWrite('bodies/' + diagSafe(e.url.split('//')[1] || e.url) .slice(0, 80) + '.txt',
          'url=' + e.url + '\nmime=' + e.mimeType + '\n\n' + body);
      }).catch(() => {});
    }
  }
}


// Site kokune gidilecekse dili URL uzerinden de sabitle (cerezden once de dogru olsun).
function localizeUrl(url) {
  if (!language || !isHttp(url)) return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)darkorbit\.com$/i.test(u.hostname)) return url;
    if ((u.pathname === '/' || u.pathname === '') && !u.search) {
      u.pathname = '/index.es';
      u.search = '?lang=' + language.code;
      return u.toString();
    }
  } catch (e) { /* ignore */ }
  return url;
}

function changeLanguage(code) {
  const s = readSettings();
  if (code) s.language = code; else delete s.language;
  writeSettings(s);

  // --lang argumanini (ve degerini) cikarip yeniden baslat
  const baseArgs = [];
  const src = process.argv.slice(1);
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    if (a === '--lang') { i++; continue; }
    if (a.indexOf('--lang=') === 0) continue;
    baseArgs.push(a);
  }
  if (code) baseArgs.push('--lang', code);
  app.relaunch({ args: baseArgs });
  app.exit(0);
}

/** Ust menu (tarayici icinden Accounts'a erisim + standart kisayollar). */
function buildAppMenu() {
  const languageItems = [
    {
      label: 'System default',
      type: 'radio',
      checked: !language,
      click: () => changeLanguage('')
    }
  ].concat(LANGUAGES.map((l) => ({
    label: l.label + ' (' + l.code + ')',
    type: 'radio',
    checked: !!language && language.code === l.code,
    click: () => changeLanguage(l.code)
  })));

  const template = [
    {
      label: 'Accounts',
      submenu: [
        { label: 'Manage accounts...', accelerator: 'CmdOrCtrl+Shift+A', click: () => openManagerWindow() },
        { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => createBrowserWindow('https://www.darkorbit.com/') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Language',
      submenu: languageItems
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: (item, win) => { if (win) win.webContents.goBack(); } },
        { label: 'Forward', accelerator: 'Alt+Right', click: (item, win) => { if (win) win.webContents.goForward(); } },
        { role: 'reload' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'F12', click: (item, win) => { if (win) win.webContents.toggleDevTools(); } },
        { type: 'separator' },
        {
          label: 'Hardware acceleration (GPU)',
          type: 'checkbox',
          checked: enableGpu,
          click: (item) => {
            const s = readSettings();
            s.hardwareAcceleration = item.checked;
            writeSettings(s);
            const baseArgs = process.argv.slice(1).filter((a) => a !== '--enable-gpu');
            const args = item.checked ? baseArgs.concat(['--enable-gpu']) : baseArgs;
            app.relaunch({ args });
            app.exit(0);
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Yeni bir Astra Browser penceresi olusturur.
 * @param initialUrl yuklenecek url
 * @param partition  bu pencerenin (ve popup'larinin) izole oturum adi.
 * @param creds      verilirse otomatik giris yapilir ({username, password}).
 */
function createBrowserWindow(initialUrl, partition, creds) {
  const part = partition || ('astra-' + rid());
  const ses = session.fromPartition(part);
  const languageReady = prepareLanguageSession(ses);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    icon: ICON_PATH,
    backgroundColor: '#000000',
    autoHideMenuBar: false,
    webPreferences: {
      partition: part, // her pencere kendi izole oturumu
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'browser-preload.js'),
      additionalArguments: language ? ['--astra-lang=' + language.code] : []
    }
  });

  // Aktif (son odaklanan) tarayici penceresini takip et
  activeBrowserWindow = win;
  win.on('focus', () => { activeBrowserWindow = win; });
  win.on('closed', () => { if (activeBrowserWindow === win) activeBrowserWindow = null; });

  // Yukleme cubugu: navigasyon/tiklama basladigi anda 'start', sayfa bitince 'done'
  const sendBar = (action) => { try { win.webContents.send('astra:bar', action); } catch (e) { /* ignore */ } };
  win.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) sendBar('start');
  });
  win.webContents.on('did-start-loading', () => sendBar('start'));
  win.webContents.on('dom-ready', () => sendBar('start'));
  win.webContents.on('did-stop-loading', () => sendBar('done'));
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) sendBar('done');
  });

  // Pencere basligi hep "Astra Browser" kalsin
  win.on('page-title-updated', (e) => e.preventDefault());

  installBackpageHook(win);

  // window.open / target=_blank -> YENI pencere, ama AYNI oturum (ayni hesap)
  win.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    if (isHttp(url)) {
      createBrowserWindow(url, part);
    }
  });

  // Sag tik menusu
  win.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();
    const add = (opts) => menu.append(new MenuItem(opts));

    if (params.linkURL) {
      add({ label: 'Open link in new window', click: () => createBrowserWindow(params.linkURL, part) });
      add({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
      add({ type: 'separator' });
    }

    add({ label: 'Back', enabled: win.webContents.canGoBack(), click: () => win.webContents.goBack() });
    add({ label: 'Forward', enabled: win.webContents.canGoForward(), click: () => win.webContents.goForward() });
    add({ label: 'Reload', click: () => win.webContents.reload() });
    add({ type: 'separator' });
    add({ label: 'Cut', enabled: params.isEditable, click: () => win.webContents.cut() });
    add({
      label: 'Copy',
      enabled: params.isEditable || (params.selectionText || '').trim().length > 0,
      click: () => win.webContents.copy()
    });
    add({ label: 'Paste', enabled: params.isEditable, click: () => win.webContents.paste() });
    add({ label: 'Select all', click: () => win.webContents.selectAll() });
    add({ type: 'separator' });
    add({ label: 'Accounts', click: () => openManagerWindow() });
    add({ type: 'separator' });
    add({ label: 'Inspect element', click: () => win.webContents.inspectElement(params.x, params.y) });
    add({ label: 'Toggle DevTools', click: () => win.webContents.toggleDevTools() });

    menu.popup({ window: win });
  });

  // Otomatik giris (hesap secildiginde)
  if (creds) {
    attachAutoLogin(win, creds);
  }

  // Tanilama: backpage acilinca oyun istemcisini (internalMapRevolution) kendisi acar.
  if (DIAG_DIR && process.env.ASTRA_DIAG_AUTOSTART === '1') {
    win.webContents.on('did-finish-load', () => {
      try {
        const u = win.webContents.getURL();
        if (win.__astraAutoStarted) return;
        if (!/indexInternal\.es\?action=internalStart/i.test(u)) return;
        win.__astraAutoStarted = true;
        const origin = (u.match(/^(https?:\/\/[^/]+)/) || [])[1];
        if (!origin) return;
        setTimeout(() => {
          try {
            createBrowserWindow(origin + '/indexInternal.es?action=internalMapRevolution', part);
          } catch (e) {
            diagNote(win, 'autostart failed: ' + e.message);
          }
        }, 1500);
      } catch (e) { /* ignore */ }
    });
  }

  if (initialUrl) {
    languageReady.then(() => {
      if (!win.isDestroyed()) win.loadURL(localizeUrl(initialUrl), { userAgent: FALLBACK_UA });
    });
  }
  return win;
}

/** Verilen pencerede hesap ile otomatik giris yapar (aktif pencere). */
async function loginInWindow(win, account) {
  try { await win.webContents.session.clearStorageData({ storages: ['cookies'] }); } catch (e) { /* ignore */ }
  try { await applyLanguageCookie(win.webContents.session); } catch (e) { /* ignore */ }
  attachAutoLogin(win, account);
  win.loadURL(localizeUrl('https://www.darkorbit.com/'), { userAgent: FALLBACK_UA });
  if (!win.isDestroyed()) win.focus();
}

/** Hesap yoneticisi penceresini acar (tekil). */
function openManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return managerWindow;
  }
  managerWindow = new BrowserWindow({
    width: 470,
    height: 580,
    title: APP_NAME + ' - Accounts',
    icon: ICON_PATH,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  managerWindow.setMenuBarVisibility(false);
  managerWindow.on('page-title-updated', (e) => e.preventDefault());
  managerWindow.loadFile(path.join(__dirname, 'manager.html'));
  managerWindow.on('closed', () => { managerWindow = null; });
  return managerWindow;
}

function registerIpc() {
  ipcMain.on('astra:bar-progress', (event, value) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    try {
      if (value < 0 || value >= 1) w.setProgressBar(-1);
      else w.setProgressBar(value);
    } catch (e) { /* ignore */ }
  });
  ipcMain.handle('accounts:list', () => accounts.list());
  ipcMain.handle('accounts:add', (e, acc) => {
    accounts.add(acc || {});
    return accounts.list();
  });
  ipcMain.handle('accounts:update', (e, id, acc) => {
    accounts.update(id, acc || {});
    return accounts.list();
  });
  ipcMain.handle('accounts:remove', (e, id) => {
    accounts.remove(id);
    return accounts.list();
  });
  ipcMain.handle('accounts:login', async (e, id) => {
    const acc = accounts.get(id);
    if (!acc) return false;

    // Accounts penceresini kapat
    if (managerWindow && !managerWindow.isDestroyed()) {
      managerWindow.close();
    }

    // Aktif tarayici penceresinde giris yap (yoksa yeni pencere ac)
    let win = activeBrowserWindow;
    if (!win || win.isDestroyed()) {
      win = createBrowserWindow(null, null);
    }
    await loginInWindow(win, acc);
    return true;
  });
  ipcMain.handle('manager:open', () => {
    openManagerWindow();
    return true;
  });
  ipcMain.on('manager:close', () => {
    if (managerWindow && !managerWindow.isDestroyed()) {
      managerWindow.close();
    }
  });
}

async function runCaptchaMode(cfg) {
  const c = (cfg.client || '').toLowerCase();
  const ua = c.includes('unity') ? 'DarkOrbit Unity Client 1.1.115' : 'BigpointClient/1.6.9';
  const partition = 'astra-captcha-' + rid();
  const ses = session.fromPartition(partition);
  try { ses.setUserAgent(ua); } catch (e) { /* ignore */ }
  applyLanguageToSession(ses);
  await applyLanguageCookie(ses);

  const proxyTypes = [];
  if (cfg.proxyHost && cfg.proxyPort) {
    const requested = cfg.proxyType || 'http';
    proxyTypes.push(requested);
    // http <-> socks5: proxy her iki protokolu desteklemeyebilir; tunnel hatasinda digerini deneriz.
    proxyTypes.push(requested === 'http' ? 'socks5' : 'http');
  }
  let proxyIdx = 0;
  const throttle = (proxyTypes[0] === 'http' && cfg.proxyHost && cfg.proxyPort)
    ? await startThrottleProxy({
      host: cfg.proxyHost,
      port: cfg.proxyPort,
      user: cfg.proxyUser,
      pass: cfg.proxyPass,
      idleMs: Number(process.env.ASTRA_PROXY_IDLE_MS) || 8000
    })
    : null;
  if (throttle) {
    console.log('Proxy tunnel: 127.0.0.1:' + throttle.port + ' -> ' +
      cfg.proxyHost + ':' + cfg.proxyPort + ' (429 retry, bosta ' +
      (Number(process.env.ASTRA_PROXY_IDLE_MS) || 8000) + 'ms sonra tunel kapanir)');
  }
  const applyProxy = async () => {
    if (!proxyTypes.length) return;
    const type = proxyTypes[proxyIdx];
    try {
      const rules = (type === 'http' && throttle)
        ? 'http://127.0.0.1:' + throttle.port
        : type + '://' + cfg.proxyHost + ':' + cfg.proxyPort;
      await ses.setProxy({ proxyRules: rules });
      console.log('Proxy: ' + rules);
    } catch (e) {
      console.error('Proxy ayarlanamadi: ' + e);
    }
  };
  await applyProxy();
  installCaptchaFilters(ses, DIAG_DIR);

  const resultFile = cfg.resultFile;
  const timeoutMs = Math.max(10000, cfg.timeout || 120000);
  let done = false;
  let timer = null;
  let poll = null;
  let noCaptchaTimer = null;
  let currentIp = '';
  const finish = (text, delayMs) => {
    if (done) return;
    done = true;
    if (poll) clearInterval(poll);
    if (timer) clearTimeout(timer);
    if (noCaptchaTimer) clearTimeout(noCaptchaTimer);
    // Token disindaki sonuclara Astra'nin cikis IP'sini ekle (bot loglar).
    let out = text;
    if (currentIp && !String(text).startsWith('[captchaResult]')) out = text + '|astraIp=' + currentIp;
    try { if (resultFile) fs.writeFileSync(resultFile, out, 'utf8'); } catch (e) { /* ignore */ }
    try { console.log(out); } catch (e) { /* ignore */ }
    try { if (throttle) throttle.close(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { app.quit(); } catch (e) { /* ignore */ } }, delayMs === undefined ? 200 : delayMs);
  };

  const win = new BrowserWindow({
    width: cfg.width || 430,
    height: cfg.height || 650,
    title: 'DarkOrbit Captcha',
    icon: ICON_PATH,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    resizable: true,
    center: true,
    webPreferences: {
      partition,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { if (!done) finish('[captchaFailed]closed'); });

  // Tanilama: captcha penceresi neden bos kaliyor? (yalnizca ASTRA_DIAG_DIR verildiginde)
  if (DIAG_DIR) {
    try { fs.mkdirSync(path.join(DIAG_DIR, 'shots'), { recursive: true }); } catch (e) { /* ignore */ }
    let shot = 0;
    const capture = async (tag) => {
      if (win.isDestroyed()) return;
      const n = ++shot;
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(DIAG_DIR, 'shots', n + '_' + tag + '.png'), img.toPNG());
      } catch (e) { /* ignore */ }
      try {
        const info = await win.webContents.executeJavaScript(`(function(){
          var t = document.body ? document.body.innerText : '';
          var frames = [];
          try {
            var f = document.querySelectorAll('iframe');
            for (var i = 0; i < f.length; i++) {
              var r = f[i].getBoundingClientRect();
              frames.push({
                src: String(f[i].src || '').split('#')[0],
                hash: String(f[i].src || '').split('#')[1] || '',
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height),
                visible: !!(r.width && r.height)
              });
            }
          } catch (e) {}
          return {
            url: location.href,
            title: document.title,
            innerTextLen: t.length,
            innerText: t.slice(0, 1500),
            hasBox: !!document.querySelector('.bgcdw_captcha'),
            hasHcaptchaFrame: !!document.querySelector('iframe[src*="hcaptcha"], iframe[title*="hCaptcha"]'),
            frames: frames,
            viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
            imgs: document.images ? document.images.length : 0,
            htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
            html: document.documentElement ? document.documentElement.outerHTML : ''
          };
        })();`, true);
        const html = info.html || '';
        delete info.html;
        fs.writeFileSync(path.join(DIAG_DIR, 'shots', n + '_' + tag + '.json'), JSON.stringify(info, null, 2));
        fs.writeFileSync(path.join(DIAG_DIR, 'shots', n + '_' + tag + '.html'), html);
      } catch (e) { /* ignore */ }
    };
    win.webContents.on('console-message', (e, level, message) => {
      try { fs.appendFileSync(path.join(DIAG_DIR, 'captcha_console.log'), level + ' ' + message + '\n'); } catch (e2) { /* ignore */ }
    });
    try {
      const netLog = path.join(DIAG_DIR, 'captcha_net.log');
      const wr = win.webContents.session.webRequest;
      wr.onCompleted((d) => {
        try { fs.appendFileSync(netLog, 'DONE ' + d.statusCode + ' ' + d.url + '\n'); } catch (e2) { /* ignore */ }
      });
      wr.onErrorOccurred((d) => {
        try { fs.appendFileSync(netLog, 'ERR ' + d.error + ' ' + d.url + '\n'); } catch (e2) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    win.webContents.on('did-finish-load', () => { capture('loaded'); });
    win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
      if (!isMain) return;
      diagWrite('captcha_fail.txt', code + ' ' + desc + ' ' + url + '\n');
      capture('fail_' + code);
    });
    [10000, 25000, 40000].forEach((ms) => setTimeout(() => capture('t' + (ms / 1000)), ms));
  }

  const refreshIp = async () => {
    currentIp = await egressIP(ses, cfg.proxyUser, cfg.proxyPass);
    if (!currentIp && !win.isDestroyed()) {
      // net.request proxy'yi gecemezse sayfa icinden dene (ayni oturum/proxy).
      try {
        const ip = await win.webContents.executeJavaScript(
          'fetch("https://api.ipify.org").then(function(r){return r.text();}).catch(function(){return "";})', true);
        currentIp = String(ip || '').trim();
      } catch (e) { /* ignore */ }
    }
    if (currentIp) {
      console.log('Astra egress IP: ' + currentIp);
      try { if (!win.isDestroyed()) win.setTitle('DarkOrbit Captcha - IP ' + currentIp); } catch (e) { /* ignore */ }
    } else {
      console.log('Astra egress IP: unknown');
    }
  };
  const injectIpBadge = () => {
    if (!currentIp || done) return;
    win.webContents.executeJavaScript(`(function(){
      if (document.getElementById('astra-ip')) return;
      var d = document.createElement('div');
      d.id = 'astra-ip';
      d.style.cssText = 'position:fixed;right:8px;bottom:8px;background:rgba(0,0,0,.78);color:#8fe3c0;font:12px Segoe UI,Arial;padding:4px 8px;border-radius:4px;z-index:2147483647';
      d.textContent = 'IP: ${currentIp}';
      document.body.appendChild(d);
    })();`, true).catch(() => {});
  };
  await refreshIp();

  timer = setTimeout(() => finish('[captchaFailed]timeout'), timeoutMs);

  // Captcha iframe'i (hCaptcha) sayfa yuklendikten SONRA olusuyor; bu yuzden
  // scroll ve "captcha var mi" kontrolu birkac saniye boyunca tekrarlanir.
  const pageProbe = `(function(){
    var box = document.querySelector('.bgcdw_captcha, .h-captcha');
    var frame = document.querySelector('iframe[src*="hcaptcha"], iframe[title*="hCaptcha"]');
    var r = box ? box.getBoundingClientRect() : null;
    return {
      hasBox: !!box,
      hasFrame: !!frame,
      boxH: r ? Math.round(r.height) : 0,
      bodyLen: (document.body ? document.body.innerText.length : 0)
    };
  })();`;

  const scheduleNoCaptchaCheck = () => {
    if (noCaptchaTimer) clearTimeout(noCaptchaTimer);
    noCaptchaTimer = setTimeout(async () => {
      if (done || win.isDestroyed()) return;
      try {
        const probe = await win.webContents.executeJavaScript(pageProbe, true);
        if (!probe.hasBox) {
          // SAS bu istekte captcha sormadi: cozulecek bir sey yok.
          finish('[captchaNotRequired]', 1200);
          return;
        }
        if (probe.hasFrame) return;
        // Kutu var ama hCaptcha iframe'i hic olusmadi: api.js istegi proxy'de
        // kaybolmus olabilir (429 / tunel hatasi). Yeniden enjekte edip dene.
        let attempt = 0;
        const tick = async () => {
          if (done || win.isDestroyed()) return;
          try {
            const p = await win.webContents.executeJavaScript(pageProbe, true);
            if (p.hasFrame) { scrollToCaptcha(); return; }
            if (attempt >= 6) {
              try {
                await win.webContents.executeJavaScript(`(function(){
                  if (document.getElementById('astra-note')) return;
                  var d = document.createElement('div');
                  d.id = 'astra-note';
                  d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#7a1f1f;color:#fff;font:13px Segoe UI,Arial;padding:10px;z-index:2147483647';
                  d.textContent = 'hCaptcha could not be loaded. The proxy is probably blocking js.hcaptcha.com / newassets.hcaptcha.com.';
                  document.body.appendChild(d);
                })();`, true);
              } catch (e) { /* ignore */ }
              finish('[captchaFailed]hcaptcha-not-loaded', 5000);
              return;
            }
            attempt++;
            await win.webContents.executeJavaScript(`(function(){
              try {
                if (window.hcaptcha && window.hcaptcha.render) {
                  var el = document.querySelector('.h-captcha');
                  if (el && !el.querySelector('iframe')) {
                    try { window.hcaptcha.render(el, { sitekey: el.getAttribute('data-sitekey') }); } catch (e) {}
                  }
                }
              } catch (e) {}
              try {
                var old = document.getElementById('astra-hc-retry');
                if (old) old.parentNode.removeChild(old);
                var s = document.createElement('script');
                s.id = 'astra-hc-retry';
                s.src = 'https://js.hcaptcha.com/1/api.js?r=' + Date.now();
                s.async = true;
                document.head.appendChild(s);
              } catch (e) {}
            })();`, true);
            setTimeout(tick, 4000);
          } catch (e) { /* ignore */ }
        };
        setTimeout(tick, 3000);
      } catch (e) { /* ignore */ }
    }, 5000);
  };

  const scrollToCaptcha = async () => {
    try {
      await win.webContents.executeJavaScript(`(function(){
        try {
          document.addEventListener('submit', function(e){ e.preventDefault(); }, true);
          var box = document.querySelector('.bgcdw_captcha') || document.querySelector('.h-captcha');
          if (box) box.scrollIntoView({ block: 'center' });
        } catch (e) {}
      })();`, true);
    } catch (e) { /* ignore */ }
  };

  win.webContents.on('did-finish-load', () => {
    scrollToCaptcha();
    refreshIp().then(() => injectIpBadge()).catch(() => {});
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      if (done || win.isDestroyed() || tries > 12) { clearInterval(iv); return; }
      try {
        const probe = await win.webContents.executeJavaScript(pageProbe, true);
        if (probe.hasBox && probe.boxH > 0) {
          clearInterval(iv);
          scrollToCaptcha();
        }
      } catch (e) { clearInterval(iv); }
    }, 500);
    scheduleNoCaptchaCheck();
  });

  win.webContents.on('did-fail-load', async (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || done) return;
    // -3 = ERR_ABORTED: baska bir navigasyon oncekini iptal etti, gercek hata degil.
    if (errorCode === -3) return;
    // Proxy tunnel hatalari: diger proxy protokolu ile bir kez daha dene.
    const tunnelError = errorCode === -111 || errorCode === -336 || errorCode === -100 || errorCode === -118 || errorCode === -130;
    if (tunnelError && proxyTypes.length > 1 && proxyIdx < proxyTypes.length - 1) {
      proxyIdx++;
      console.log('Load failed (' + errorCode + '), proxy tipi tekrar deneniyor: ' + proxyTypes[proxyIdx]);
      await applyProxy();
      await refreshIp();
      try { await win.loadURL(localizeUrl(cfg.url || 'https://www.darkorbit.com/'), { userAgent: ua }); } catch (e) { /* asagida ele alinir */ }
      return;
    }
    const reason = '[captchaFailed]load:' + errorCode + ':' + errorDescription +
      (proxyTypes.length ? ':proxy=' + proxyTypes[proxyIdx] : '');
    console.log(reason);
    try {
      const html = '<html><body style="font-family:Segoe UI,Arial;background:#1e1e1e;color:#eee;padding:18px">' +
        '<h3 style="margin:0 0 10px">Page could not be loaded</h3>' +
        '<p style="margin:0 0 8px">Error ' + errorCode + ': ' + String(errorDescription || '') + '</p>' +
        '<p style="margin:0;color:#bbb">URL: ' + String(validatedURL || '') + '</p>' +
        (proxyTypes.length ? '<p style="margin:8px 0 0;color:#bbb">Proxy: ' + proxyTypes[proxyIdx] + '://' + cfg.proxyHost + ':' + cfg.proxyPort + '</p>' : '') +
        '</body></html>';
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    } catch (e) { /* ignore */ }
    finish(reason, 4000);
  });

  poll = setInterval(() => {
    if (done || win.isDestroyed()) return;
    win.webContents.executeJavaScript(`(function(){
      var els = document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], input[name="h-captcha-response"], input[name="g-recaptcha-response"]');
      for (var i = 0; i < els.length; i++) {
        var v = (els[i].value || '').trim();
        if (v.length > 20) return v;
      }
      return '';
    })();`, true).then((token) => {
      if (token && token.length > 20) finish('[captchaResult]' + token);
    }).catch(() => {});
  }, 500);

  try { win.show(); win.focus(); } catch (e) { /* ignore */ }

  try {
    const targetUrl = localizeUrl(cfg.url || 'https://www.darkorbit.com/');
    console.log('Captcha URL: ' + targetUrl);
    await win.loadURL(targetUrl, { userAgent: ua });
  } catch (e) {
    if (!done) console.log('loadURL rejected: ' + e.message);
  }
}

const args = parseArgs(process.argv.slice(1));

// Alternatif: parametre yerine ortam degiskenleri (ProcessBuilder ile daha guvenli).
if (process.env.ASTRA_MODE === 'captcha' || process.env.ASTRA_CAPTCHA === '1') args.captcha = true;
if (process.env.ASTRA_RESULT_FILE) args.resultFile = process.env.ASTRA_RESULT_FILE;
if (process.env.ASTRA_CLIENT) args.client = process.env.ASTRA_CLIENT;
if (process.env.ASTRA_URL) args.url = process.env.ASTRA_URL;
if (process.env.ASTRA_TIMEOUT) args.timeout = parseInt(process.env.ASTRA_TIMEOUT, 10) || args.timeout;
if (process.env.ASTRA_WIDTH) args.width = parseInt(process.env.ASTRA_WIDTH, 10) || args.width;
if (process.env.ASTRA_HEIGHT) args.height = parseInt(process.env.ASTRA_HEIGHT, 10) || args.height;
if (process.env.ASTRA_PROXY_HOST) args.proxyHost = process.env.ASTRA_PROXY_HOST;
if (process.env.ASTRA_PROXY_PORT) args.proxyPort = process.env.ASTRA_PROXY_PORT;
if (process.env.ASTRA_PROXY_USER) args.proxyUser = process.env.ASTRA_PROXY_USER;
if (process.env.ASTRA_PROXY_PASS) args.proxyPass = process.env.ASTRA_PROXY_PASS;
if (process.env.ASTRA_PROXY_TYPE) args.proxyType = process.env.ASTRA_PROXY_TYPE;
if (process.env.ASTRA_LANG) args.lang = process.env.ASTRA_LANG;

// Dil: --lang / ASTRA_LANG / settings.json. --lang switch'i ready'den once verilmeli.
language = resolveLanguage();
if (language) {
  app.commandLine.appendSwitch('lang', language.code);
  console.log('Language: ' + language.code + ' (' + language.locale + ')');
}

// Proxy kimlik dogrulamasi (SOCKS5/HTTP). Bot ile ayni proxy kullanildiginda gerekir.
if (args.proxyHost && args.proxyPort) {
  app.on('login', (event, webContents, request, authInfo, callback) => {
    if (authInfo && authInfo.isProxy) {
      event.preventDefault();
      callback(args.proxyUser || '', args.proxyPass || '');
    }
  });
}
const flashPath = findFlash();

// Flash'i aktive et (kaiserdj client ile ayni yaklasim)
app.commandLine.appendSwitch('ppapi-flash-path', flashPath);
app.commandLine.appendSwitch('ignore-certificate-errors');

// GPU / donanim hizlandirma: bazi ekran karti/suruculerde siyah ekrana yol acar.
// Varsayilan olarak KAPALI (yazilim render). Acmak icin menu > View > "Hardware acceleration (GPU)",
// ya da --enable-gpu argumani / ASTRA_GPU=1 ortam degiskeni.
function settingsPath() {
  const dir = path.join(app.getPath('appData'), 'Astra Browser');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return path.join(dir, 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (e) { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

const enableGpu = process.argv.includes('--enable-gpu')
  || process.env.ASTRA_GPU === '1'
  || readSettings().hardwareAcceleration === true;
if (!enableGpu) {
  try { app.disableHardwareAcceleration(); } catch (e) { /* ignore */ }
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

app.on('window-all-closed', () => app.quit());

// Kurulu surumu bot okuyabilsin diye damga dosyasi yaz.
// (%APPDATA%\Astra Browser\version.txt ve exe'nin yanindaki version.txt)
function writeVersionMarker() {
  const body = app.getVersion() + '\r\n';
  const targets = [];
  try { targets.push(path.join(app.getPath('appData'), 'Astra Browser', 'version.txt')); } catch (e) { /* ignore */ }
  try { targets.push(path.join(path.dirname(app.getPath('exe')), 'version.txt')); } catch (e) { /* ignore */ }
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, 'utf8');
    } catch (e) { /* ignore */ }
  }
}

app.whenReady().then(async () => {
  writeVersionMarker();

  if (DIAG_DIR) {
    try { fs.mkdirSync(DIAG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    console.log('DIAG dir: ' + DIAG_DIR);
  }

  if (args.selftest) {
    const lines = [
      'selftest=ok',
      'name=' + APP_NAME,
      'electron=' + process.versions.electron,
      'chromium=' + process.versions.chrome,
      'node=' + process.versions.node,
      'appPath=' + app.getAppPath(),
      'userData=' + app.getPath('userData'),
      'accounts=' + accounts.storePath(),
      'flash=' + flashPath + ' exists=' + fs.existsSync(flashPath)
    ];
    lines.forEach((l) => console.log(l));
    try {
      fs.writeFileSync(path.join(path.dirname(app.getPath('exe')), 'selftest.log'), lines.join('\r\n'), 'utf8');
    } catch (e) { /* ignore */ }
    app.quit();
    return;
  }

  if (args.captcha) {
    await runCaptchaMode(args);
    return;
  }

  registerIpc();
  Menu.setApplicationMenu(buildAppMenu());

  if (args.dosid || args.url) {
    const target = resolveTarget(args);

    // Bu pencere icin izole GECICI oturum (bellekte tutulur, kapaninca temizlenir)
    const partition = 'astra-' + rid();
    const ses = session.fromPartition(partition);
    try { ses.setUserAgent(FALLBACK_UA); } catch (e) { /* ignore */ }
    await prepareLanguageSession(ses);

    // dosid cookie'sini YALNIZCA bu pencerenin oturumuna ekle
    if (target.sid && target.origin) {
      try {
        await ses.cookies.set({
          url: target.origin,
          name: 'dosid',
          value: target.sid,
          secure: true,
          httpOnly: true
        });
      } catch (e) {
        console.error('Could not set dosid cookie: ' + e);
      }
    }

    createBrowserWindow(target.targetUrl, partition);
  } else {
    // Parametresiz acilista normal tarayici penceresi (hesaplara menu'den gidilir)
    createBrowserWindow('https://www.darkorbit.com/');
  }
});
