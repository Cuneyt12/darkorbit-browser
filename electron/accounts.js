'use strict';

// Kayitli hesaplarin saklandigi modul.
// Konum: %APPDATA%\Astra Browser\accounts.json

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function storePath() {
  const dir = path.join(app.getPath('appData'), 'Astra Browser');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'accounts.json');
}

function loadAll() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.accounts)) return data.accounts;
    return [];
  } catch (e) {
    return [];
  }
}

function saveAll(accounts) {
  fs.writeFileSync(storePath(), JSON.stringify({ accounts: accounts }, null, 2), 'utf8');
}

function makeId() {
  return String(Date.now()) + Math.random().toString(16).slice(2, 6);
}

function list() {
  // Sifre alanini istemciye gondermeden once kopya uretilebilir; simulator burada tam donduruyor.
  return loadAll();
}

function add(acc) {
  const accounts = loadAll();
  const account = {
    id: makeId(),
    username: (acc && acc.username ? String(acc.username) : '').trim(),
    password: acc && acc.password ? String(acc.password) : ''
  };
  accounts.push(account);
  saveAll(accounts);
  return account;
}

function update(id, acc) {
  const accounts = loadAll();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx >= 0) {
    accounts[idx] = {
      id: id,
      username: (acc && acc.username ? String(acc.username) : '').trim(),
      password: acc && acc.password ? String(acc.password) : ''
    };
    saveAll(accounts);
    return accounts[idx];
  }
  return null;
}

function remove(id) {
  const accounts = loadAll().filter((a) => a.id !== id);
  saveAll(accounts);
}

function get(id) {
  return loadAll().find((a) => a.id === id) || null;
}

module.exports = { list, add, update, remove, get, storePath };
