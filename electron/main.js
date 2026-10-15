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
  const out = { dosid: null, url: null, instance: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      out.selftest = true;
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
        { label: 'Toggle DevTools', accelerator: 'F12', click: (item, win) => { if (win) win.webContents.toggleDevTools(); } }
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

const args = parseArgs(process.argv.slice(1));
const flashPath = findFlash();

// Flash'i aktive et (kaiserdj client ile ayni yaklasim)
app.commandLine.appendSwitch('ppapi-flash-path', flashPath);
app.commandLine.appendSwitch('ignore-certificate-errors');

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
