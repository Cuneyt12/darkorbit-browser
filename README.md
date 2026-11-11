# Astra Browser

A lightweight, Windows desktop browser built to open the **DarkOrbit** "backpage" (the legacy Flash game client) by injecting the `dosid` session cookie and rendering it with a bundled Flash-capable Chromium.

It is a small Electron app that bundles Chromium 87 and Adobe's Pepper Flash, so it can still display the old Flash client without any system-wide Flash installation.

## Features

- Opens the DarkOrbit backpage from a `dosid` URL or a bare session id.
- **Account manager**: save multiple accounts, auto-login with one click, edit and delete them.
- **Isolated sessions per window**: each window uses its own temporary session, so different accounts' cookies (`dosid`, etc.) never mix.
- Popups (shop, board, payment, …) open in **new windows** and share the opener's session.
- Automatic **Quantcast consent** handling (accepts the cookie banner, up to two times).
- Top loading bar and taskbar progress while pages load.
- Standard browser conveniences: back/forward, reload, zoom, copy/paste, right-click menu and DevTools (F12).

## Requirements

**To run (end users):**
- Windows 10 / 11, 64-bit (x64).
- No Java, .NET or Flash installation required — everything is bundled.
- No admin rights needed (per-user install).

**To build (developers):**
- Node.js + npm.
- Windows x64.

## Build

```bash
npm install
npm run dist
```

The installer is written to `dist/AstraBrowser-Setup-<version>.exe`.

Other scripts:

```bash
npm start      # run the app locally (electron .)
npm run pack   # build an unpacked app (dist/win-unpacked)
```

The setup is a per-user, one-click NSIS installer. It installs to
`%LOCALAPPDATA%\Programs\astra-browser` and creates Desktop and Start Menu shortcuts.

## Usage

- Launch **Astra Browser** to open a normal browser window, then use **Accounts** in the menu bar (or `Ctrl+Shift+A`) to manage and log into accounts.
- From the bot / other tools, pass a `dosid` URL:

  ```
  "Astra Browser.exe" --dosid "https://int1.darkorbit.com/indexInternal.es?dosid=XXXX"
  ```

Accounts and their passwords are stored at `%APPDATA%\Astra Browser\accounts.json`.

### Command-line arguments

| Argument | Description |
| --- | --- |
| `--dosid <url-or-id>` | A full backpage URL containing `dosid`/`sid`, or a bare session id. |
| `--url <url>` | Explicit URL to open (used with a bare `--dosid`). |
| `--instance <name>` | Server instance (e.g. `int1`) used with a bare `--dosid`. |
| `--selftest` | Print diagnostics and exit (used for verification). |
| `--captcha` | Open a small captcha window, let the user solve hCaptcha, and write the token to the result file. |
| `--client <Flash\|Unity>` | Client/user-agent for captcha login (`BigpointClient/1.6.9` or `DarkOrbit Unity Client 1.1.115`). |
| `--result-file <path>` | Result file for captcha mode: `[captchaResult]<token>` or `[captchaFailed]<reason>`. |
| `--timeout <ms>` | Captcha timeout (default `120000`). |
| `--width <px>`, `--height <px>` | Captcha window size (default `430x650`). |
| `--proxy-host <host>`, `--proxy-port <port>` | Proxy used by the captcha window. |
| `--proxy-user <user>`, `--proxy-pass <pass>` | Proxy credentials. |
| `--proxy-type <http\|socks5>` | Proxy type (default `http`; HTTP CONNECT auth is more reliable in Chromium). |
| `--lang <code>` | Browser language (`en`, `de`, `es`, `fr`, `it`, `pl`, `pt`, `ro`, `ru`, `tr`, `cs`, `hu`, `nl`, `bg`, `el`). Sets `navigator.language` and the `Accept-Language` header. |

### Language

The browser language controls both `navigator.language` and the `Accept-Language`
request header, so the DarkOrbit pages (login, backpage, hCaptcha widget) are served
in that language.

- GUI: top menu **Language**, pick a language; the app restarts with it.
- CLI: `"Astra Browser.exe" --lang de`
- Env: `set ASTRA_LANG=de` (inherited by the bot when it launches the captcha window)
- Persisted in `%APPDATA%\Astra Browser\settings.json` as `language`.

`System default` removes the override and uses the Windows locale. The language
does not change the in-game language of an account; that is stored on the DarkOrbit
account itself and follows the site's selector.

### Captcha mode

The captcha window can also be configured with environment variables, which avoids
putting credentials on the command line:

```bat
set ASTRA_MODE=captcha
set ASTRA_RESULT_FILE=C:\temp\captcha.txt
set ASTRA_CLIENT=Flash
set ASTRA_URL=https://www.darkorbit.com/
set ASTRA_TIMEOUT=120000
set ASTRA_PROXY_TYPE=http
set ASTRA_PROXY_HOST=127.0.0.1
set ASTRA_PROXY_PORT=8080
set ASTRA_PROXY_USER=user
set ASTRA_PROXY_PASS=pass
set ASTRA_LANG=de
"Astra Browser.exe"
```

The window loads the login page with the selected client user-agent. The user
only solves the captcha; form submission is blocked so the token is not consumed.
When solved, the token is written to `ASTRA_RESULT_FILE` as
`[captchaResult]<token>` and the window closes. The caller should submit the token
immediately (single-use) and must use the same egress IP as the browser.

Other results the caller has to handle:

| Result | Meaning |
| --- | --- |
| `[captchaNotRequired]` | The login page was served **without** a captcha block, so there is nothing to solve. Retry the login without a token. |
| `[captchaFailed]timeout` | Nobody solved the captcha before `ASTRA_TIMEOUT`. |
| `[captchaFailed]closed` | The window was closed manually. |
| `[captchaFailed]load:<code>:<text>:proxy=<type>` | The page (or the proxy tunnel) could not be loaded. The error page shows the code; the proxy type that failed is included. |
| `[captchaFailed]hcaptcha-not-loaded` | The captcha block exists but the hCaptcha iframe never rendered — usually the proxy blocks `js.hcaptcha.com` / `newassets.hcaptcha.com`. |

The captcha challenge is decided per request by the server, not per IP: a page
load can legitimately come back without a captcha even when an earlier load from
the same IP had one. That is what `[captchaNotRequired]` reports.

If `http` tunneling fails, the window retries the same proxy once as `socks5`
(and vice versa) before reporting a load error.


## How it works

- Uses a bundled **Electron 11.5.0 / Chromium 87** runtime (the last Chromium with Flash support).
- Enables Flash via `--ppapi-flash-path` pointing at the bundled `flash/pepflashplayer.dll`.
- Sets the `dosid` cookie for the target origin and loads the game page with the
  `BigpointClient` user agent so the server serves the Flash backpage.
- Each window gets its own in-memory session partition for account isolation.

## AI Disclosure

This project was built with the help of an AI coding assistant. Most of the source code, configuration files and documentation were generated by a large language model under the direction and review of the human author, who defined the requirements, made the technical decisions and did the testing.

Because of this, the code may contain bugs, mistakes or security issues that were not fully reviewed. It is provided **"as is", without any warranty**. Use it at your own risk and review it before relying on it.

## Disclaimer

This is an unofficial, third-party tool. It is **not affiliated with, endorsed by or connected to Bigpoint or DarkOrbit** in any way. It bundles an older Chromium build and Adobe's Pepper Flash (`pepflashplayer.dll`) to render the legacy Flash client; those components remain the property of their respective owners. "Bigpoint" and "DarkOrbit" are trademarks of their respective owners.
