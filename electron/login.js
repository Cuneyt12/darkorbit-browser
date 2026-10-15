'use strict';

// DarkOrbit otomatik giris modulu.
// www.darkorbit.com uzerindeki giris formunu doldurup gonderir.
// (kaiserdj client ile ayni alan id'leri; ek olarak genel seciciler yedekli)

const { dialog } = require('electron');

function buildScript(username, password) {
  const u = JSON.stringify(String(username));
  const p = JSON.stringify(String(password));
  return `(function(){
    try {
      var u = document.getElementById('bgcdw_login_form_username')
              || document.querySelector('input[name="username"]');
      var pw = document.getElementById('bgcdw_login_form_password')
              || document.querySelector('input[name="password"]');
      var btn = document.querySelector('input.bgcdw_login_form_login[type=submit]')
              || document.querySelector('input[type=submit]')
              || document.querySelector('button[type=submit]');
      if (!u || !pw || !btn) return 'noform';
      if (document.querySelectorAll('iframe[title="reCAPTCHA"]').length !== 0) return 'captcha';
      function setVal(el, val){
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setVal(u, ${u});
      setVal(pw, ${p});
      btn.click();
      return 'submitted';
    } catch (e) {
      return 'error:' + e.message;
    }
  })();`;
}

const isLoginSite = (url) => {
  try {
    return new URL(url).host === 'www.darkorbit.com';
  } catch (e) {
    return false;
  }
};

function attempt(win, n) {
  if (win.isDestroyed()) return;
  const account = win.__astraAccount;
  if (!account) return;
  if (!isLoginSite(win.webContents.getURL())) return;

  win.webContents
    .executeJavaScript(buildScript(account.username, account.password), true)
    .then((res) => {
      if (res === 'submitted') {
        win.__astraAccount = null;
      } else if (res === 'captcha') {
        win.__astraAccount = null;
        dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Captcha',
          message: 'A security check (captcha) is present. Please log in manually and complete the captcha.',
          buttons: ['OK']
        });
      } else if (n < 6) {
        setTimeout(() => attempt(win, n + 1), 1500);
      }
    })
    .catch(() => {
      if (n < 6) setTimeout(() => attempt(win, n + 1), 1500);
    });
}

/**
 * Pencereye otomatik giris davranisi ekler.
 * Ayni pencerede tekrar cagrilirsa bekleyen hesap guncellenir
 * (listener bir kez baglanir, tekrar tekrar eklenmez).
 */
function attachAutoLogin(win, account) {
  win.__astraAccount = account;
  if (!win.__astraLoginBound) {
    win.__astraLoginBound = true;
    win.webContents.on('did-finish-load', () => {
      if (win.__astraAccount && isLoginSite(win.webContents.getURL())) {
        attempt(win, 0);
      }
    });
  }
}

module.exports = { attachAutoLogin };
