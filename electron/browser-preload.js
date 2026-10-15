'use strict';

// Tarayici pencerelerinde ustte yukleme cubugu.
// - Navigasyon basladigi anda (main surecten gelen 'start' ile) gorunur.
// - Yuzde, yukleme ilerledikce kademeli olarak dolar (yaklasik/oransal).
// - Sayfa tamamlaninca %100'e ulasip kaybolur.

const { ipcRenderer } = require('electron');

(function () {
  const ID = '__astra_loadbar';
  const SID = '__astra_loadbar_style';

  let wrap = null;
  let inner = null;
  let trickle = null;
  let width = 0;
  let active = false;

  function ensureStyle() {
    if (document.getElementById(SID)) return;
    const style = document.createElement('style');
    style.id = SID;
    style.textContent =
      '#' + ID + '{position:fixed;top:0;left:0;width:100%;height:3px;' +
      'z-index:2147483647;pointer-events:none;background:rgba(46,125,50,0.12);' +
      'transition:opacity .35s ease;opacity:1;}' +
      '#' + ID + '>div{height:100%;width:0;' +
      'background:linear-gradient(90deg,#2e7d32,#7ECE3B);' +
      'box-shadow:0 0 6px rgba(126,206,59,.9);}';
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBar() {
    if (wrap && document.documentElement && document.documentElement.contains(wrap)) return;
    const root = document.documentElement;
    if (!root) return;
    ensureStyle();
    wrap = document.createElement('div');
    wrap.id = ID;
    inner = document.createElement('div');
    wrap.appendChild(inner);
    root.appendChild(wrap);
    if (inner) inner.style.width = width + '%';
  }

  function report() {
    // Gorev cubugu gostergesi icin main'e bildir (0..0.99 aktif, <0 temizle)
    let v = -1;
    if (active) v = Math.min(width / 100, 0.99);
    try { ipcRenderer.send('astra:bar-progress', v); } catch (e) { /* ignore */ }
  }

  function setWidth(p, animate) {
    width = p;
    ensureBar();
    if (inner) {
      inner.style.transition = animate ? 'width .25s ease-out' : 'none';
      inner.style.width = p + '%';
    }
    report();
  }

  function start() {
    if (active) return;
    active = true;
    ensureBar();
    setWidth(8, true);
    setTimeout(() => { if (active && width < 16) setWidth(16, true); }, 180);
    if (trickle) clearInterval(trickle);
    trickle = setInterval(() => {
      if (!active) return;
      const step = Math.max(0.25, (90 - width) * 0.06);
      setWidth(Math.min(90, width + step), true);
    }, 300);
  }

  function finish() {
    if (trickle) { clearInterval(trickle); trickle = null; }
    if (!active) { report(); return; }
    active = false;
    setWidth(100, true);
    const w = wrap;
    wrap = null;
    inner = null;
    setTimeout(() => {
      if (w) w.style.opacity = '0';
      setTimeout(() => { if (w && w.parentNode) w.parentNode.removeChild(w); }, 350);
    }, 220);
  }

  ipcRenderer.on('astra:bar', (e, action) => {
    if (action === 'start') start();
    else if (action === 'done') finish();
  });

  // Yeni dokuman basinda goster (main 'start' gonderemese bile)
  start();
  document.addEventListener('DOMContentLoaded', start);
  window.addEventListener('load', finish);
  setTimeout(finish, 20000);
})();

// Quantcast CMP (cerez izni) popup'ini otomatik kabul et.
// (.qc-cmp2-summary-buttons icindeki birincil/"Consent" butonuna tiklar)
// ONEMLI: her gorunuste kabul eder (tek seferle sinirli DEGIL).
(function () {
  function acceptQuantcast() {
    try {
      const buttons = document.querySelectorAll('.qc-cmp2-summary-buttons button');
      if (!buttons || !buttons.length) return false;
      let target = null;
      for (let i = 0; i < buttons.length; i++) {
        const mode = (buttons[i].getAttribute('mode') || '').toLowerCase();
        if (mode === 'primary') { target = buttons[i]; break; }
      }
      if (!target) target = buttons[buttons.length - 1]; // son buton genelde "Consent"
      if (target) { target.click(); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  const MAX_ACCEPTS = 2;
  let accepts = 0;
  let lastClick = 0;
  let timer = null;
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function tick() {
    if (accepts >= MAX_ACCEPTS) { stop(); return; }
    if (Date.now() - lastClick < 1500) return; // spam engelle
    if (acceptQuantcast()) {
      lastClick = Date.now();
      accepts++;
      if (accepts >= MAX_ACCEPTS) stop();
    }
  }

  // En fazla 2 kez kabul et, sonra dur.
  tick();
  document.addEventListener('DOMContentLoaded', tick);
  timer = setInterval(tick, 1000);
})();

