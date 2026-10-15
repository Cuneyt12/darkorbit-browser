'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('astra', {
  list: () => ipcRenderer.invoke('accounts:list'),
  add: (acc) => ipcRenderer.invoke('accounts:add', acc),
  update: (id, acc) => ipcRenderer.invoke('accounts:update', id, acc),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  login: (id) => ipcRenderer.invoke('accounts:login', id),
  close: () => ipcRenderer.send('manager:close')
});
