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

const { app, BrowserWindow, session, Menu, MenuItem, clipboard, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const accounts = require('./accounts');
const { attachAutoLogin } = require('./login');

const APP_NAME = 'Astra Browser';

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
    width: 430, height: 650,
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

let managerWindow = null;
let activeBrowserWindow = null;

/** Ust menu (tarayici icinden Accounts'a erisim + standart kisayollar). */
function buildAppMenu() {
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
      preload: path.join(__dirname, 'browser-preload.js')
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
    win.loadURL(initialUrl, { userAgent: FALLBACK_UA });
  }
  return win;
}

/** Verilen pencerede hesap ile otomatik giris yapar (aktif pencere). */
async function loginInWindow(win, account) {
  try { await win.webContents.session.clearStorageData({ storages: ['cookies'] }); } catch (e) { /* ignore */ }
  attachAutoLogin(win, account);
  win.loadURL('https://www.darkorbit.com/', { userAgent: FALLBACK_UA });
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
  if (cfg.proxyHost && cfg.proxyPort) {
    try {
      const proxyType = cfg.proxyType || 'http';
      await ses.setProxy({ proxyRules: proxyType + '://' + cfg.proxyHost + ':' + cfg.proxyPort });
    } catch (e) {
      console.error('Proxy ayarlanamadi: ' + e);
    }
  }

  const resultFile = cfg.resultFile;
  const timeoutMs = Math.max(10000, cfg.timeout || 120000);
  let done = false;
  let timer = null;
  let poll = null;
  const finish = (text) => {
    if (done) return;
    done = true;
    if (poll) clearInterval(poll);
    if (timer) clearTimeout(timer);
    try { if (resultFile) fs.writeFileSync(resultFile, text, 'utf8'); } catch (e) { /* ignore */ }
    try { console.log(text); } catch (e) { /* ignore */ }
    setTimeout(() => { try { app.quit(); } catch (e) { /* ignore */ } }, 200);
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

  timer = setTimeout(() => finish('[captchaFailed]timeout'), timeoutMs);

  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`(function(){
      try {
        document.addEventListener('submit', function(e){ e.preventDefault(); }, true);
        var c = document.querySelector('.bgcdw_captcha') || document.querySelector('.h-captcha');
        if (c) c.scrollIntoView({ block: 'center' });
      } catch (e) {}
    })();`, true).catch(() => {});
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

  try {
    await win.loadURL(cfg.url || 'https://www.darkorbit.com/', { userAgent: ua });
  } catch (e) {
    finish('[captchaFailed]load');
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

app.whenReady().then(async () => {
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
