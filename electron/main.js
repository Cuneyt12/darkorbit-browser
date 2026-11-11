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

// Backpage HTML'i sunucudan "tr" olarak geliyor (ulke sunuculari). Istemci dilini
// bu HTML'deki flashvar belirledigi icin yanit govdesini CDP ile yeniden yaziyoruz:
//   "lang":"tr"  ->  "lang":"de"
// Boylece TR sunucusunda da oyun istemcisi secilen dilde acilir.
function installLanguageRewrite(win) {
  if (!language) return;
  const dbg = win.webContents.debugger;
  let ready = false;
  let busy = false;

  const enable = () => {
    if (ready || busy) return;
    busy = true;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (e) {
      /* zaten bagli olabilir */
    }
    ready = true;
    busy = false;
    dbg.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*indexInternal.es*', requestStage: 'Response' }]
    }).catch(() => { /* ignore */ });
  };

  dbg.on('message', async (event, method, params) => {
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
      let changed = false;
      body = body.replace(/("(?:lang|language)"\s*:\s*")([a-zA-Z_]{2,5})(")/g, (m, a, v, b) => {
        if (v.toLowerCase() === language.code) return m;
        changed = true;
        return a + language.code + b;
      });
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
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId: id }); } catch (e2) { /* ignore */ }
    }
  });

  win.webContents.on('did-start-navigation', (e, u, inPlace, isMainFrame) => {
    if (isMainFrame) enable();
  });
  win.webContents.on('dom-ready', enable);
  win.webContents.on('did-finish-load', () => {
    try {
      if (dbg.isAttached()) {
        dbg.sendCommand('Fetch.disable').catch(() => {});
        dbg.detach();
      }
    } catch (e) { /* ignore */ }
    ready = false; // sonraki navigasyonda yeniden baglan
  });
  enable();
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

  installLanguageRewrite(win);

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
  const applyProxy = async () => {
    if (!proxyTypes.length) return;
    const type = proxyTypes[proxyIdx];
    try {
      await ses.setProxy({ proxyRules: type + '://' + cfg.proxyHost + ':' + cfg.proxyPort });
      console.log('Proxy: ' + type + '://' + cfg.proxyHost + ':' + cfg.proxyPort);
    } catch (e) {
      console.error('Proxy ayarlanamadi: ' + e);
    }
  };
  await applyProxy();

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
        // Kutu var ama hCaptcha iframe'i hic olusmadi: widget yuklenemedi
        // (genelde proxy js.hcaptcha.com / newassets.hcaptcha.com'u engelliyor).
        setTimeout(async () => {
          if (done || win.isDestroyed()) return;
          try {
            const p2 = await win.webContents.executeJavaScript(pageProbe, true);
            if (p2.hasBox && !p2.hasFrame) {
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
            }
          } catch (e) { /* ignore */ }
        }, 8000);
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
