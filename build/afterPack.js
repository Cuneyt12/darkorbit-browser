'use strict';

// electron-builder "afterPack" kancasi:
// Uretilen exe'ye Astra Browser ikonunu ve surum bilgilerini gomer (rcedit.exe ile).
// Boylece setup ve olusan kisayol Astra logosunu kullanir (kod imzalama gerektirmez).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = async function (context) {
  try {
    const appOutDir = context.appOutDir;
    const exe = path.join(appOutDir, 'Astra Browser.exe');
    const icon = path.join(__dirname, 'icon.ico');

    const rcedit = path.join(
      __dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'
    );
    if (!fs.existsSync(rcedit)) {
      console.error('[afterPack] rcedit-x64.exe bulunamadi: ' + rcedit);
      return;
    }

    execFileSync(rcedit, [
      exe,
      '--set-icon', icon,
      '--set-file-version', '1.0.0.0',
      '--set-product-version', '1.0.0.0',
      '--set-version-string', 'ProductName', 'Astra Browser',
      '--set-version-string', 'FileDescription', 'Astra Browser',
      '--set-version-string', 'CompanyName', 'Cuneyt',
      '--set-version-string', 'LegalCopyright', 'Cuneyt',
      '--set-version-string', 'OriginalFilename', 'Astra Browser.exe'
    ]);

    console.log('[afterPack] Astra ikonu exe-ye gomuldu: ' + exe);
  } catch (e) {
    console.error('[afterPack] rcedit uygulanamadi: ' + e);
  }
};
