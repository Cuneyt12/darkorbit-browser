'use strict';

const api = window.astra;

const listEl = document.getElementById('list');
const formEl = document.getElementById('form');
const titleEl = document.getElementById('formTitle');
const userEl = document.getElementById('username');
const passEl = document.getElementById('password');

let editingId = null;

function showForm(acc) {
  editingId = acc ? acc.id : null;
  titleEl.textContent = acc ? 'Edit account' : 'New account';
  userEl.value = acc ? acc.username : '';
  passEl.value = acc ? acc.password : '';
  formEl.classList.add('show');
  userEl.focus();
  userEl.select();
}

function hideForm() {
  editingId = null;
  formEl.classList.remove('show');
}

async function refresh() {
  const accounts = await api.list();
  listEl.innerHTML = '';

  if (!accounts.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No accounts yet. Click "+ Add account" to create one.';
    listEl.appendChild(e);
    return;
  }

  accounts.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'acc';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.username;
    row.appendChild(name);

    const login = document.createElement('button');
    login.className = 'primary';
    login.textContent = 'Login';
    login.onclick = () => api.login(a.id);
    row.appendChild(login);

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.onclick = () => showForm(a);
    row.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (confirm('Delete account "' + a.username + '"?')) {
        await api.remove(a.id);
        refresh();
      }
    };
    row.appendChild(del);

    listEl.appendChild(row);
  });
}

document.getElementById('newBtn').onclick = () => showForm(null);
document.getElementById('cancelBtn').onclick = hideForm;

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const acc = { username: userEl.value.trim(), password: passEl.value };
  if (!acc.username) {
    userEl.focus();
    return;
  }
  if (editingId) {
    await api.update(editingId, acc);
  } else {
    await api.add(acc);
  }
  hideForm();
  refresh();
});

refresh();
