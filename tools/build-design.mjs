#!/usr/bin/env node
// Сборка внутренней страницы вариантов дизайна: site/design/index.html.
// Скрипт проходит по site/design/<номер>/, снимает preview.jpg через headless Chrome
// и собирает индекс. Ноль зависимостей: Node 22+ и установленный Chrome/Edge.
//
// Запуск: node tools/build-design.mjs
// После добавления варианта достаточно перезапустить скрипт.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const designDir = join(root, 'site', 'design');
const previewWidth = 1440;
const previewHeight = 1000;

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const chrome = chromeCandidates.find(existsSync);
if (!chrome) {
  console.error('Chrome или Edge не найден. Укажи путь в CHROME_PATH.');
  process.exit(2);
}

const variants = readdirSync(designDir)
  .filter(name => /^\d+$/.test(name) && statSync(join(designDir, name)).isDirectory())
  .map(name => {
    const dir = join(designDir, name);
    const metaPath = join(dir, 'meta.json');
    const htmlPath = join(dir, 'index.html');
    if (!existsSync(htmlPath) || !existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    return { dir: name, htmlPath, order: meta.order ?? Number(name), title: meta.title ?? name, description: meta.description ?? '', tags: meta.tags ?? [] };
  })
  .filter(Boolean)
  .sort((a, b) => a.order - b.order || Number(a.dir) - Number(b.dir));

if (!variants.length) {
  console.error('В site/design нет папок с index.html и meta.json.');
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* браузер ещё стартует */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('CDP не поднялся за 10 секунд');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(`${msg.sessionId ?? ''}:${msg.method}`) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  once(method, sessionId, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const key = `${sessionId ?? ''}:${method}`;
      const timer = setTimeout(() => reject(new Error(`Нет события ${method}`)), timeout);
      const fn = params => {
        clearTimeout(timer);
        this.listeners.set(key, (this.listeners.get(key) ?? []).filter(f => f !== fn));
        resolve(params);
      };
      this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn]);
    });
  }
  close() { this.ws.close(); }
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const profileDir = mkdtempSync(join(tmpdir(), 'design-build-'));
const port = await freePort();
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });

let cdp;
try {
  cdp = new CDP(await waitForDebugger(port));
  await cdp.ready;

  for (const v of variants) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: previewWidth, height: previewHeight, deviceScaleFactor: 1,
      mobile: false, screenWidth: previewWidth, screenHeight: previewHeight,
    }, sessionId);

    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: `file:///${v.htmlPath.replace(/\\/g, '/')}` }, sessionId);
    await loaded;
    await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
    await new Promise(r => setTimeout(r, 300));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }, sessionId);
    writeFileSync(join(designDir, v.dir, 'preview.jpg'), Buffer.from(shot.data, 'base64'));
    await cdp.send('Target.closeTarget', { targetId });
    console.log(`preview: ${v.dir} — ${v.title}`);
  }
} finally {
  cdp?.close();
  browser.kill();
  await new Promise(resolve => {
    if (browser.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    browser.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  for (let i = 0; i < 20; i++) {
    try { rmSync(profileDir, { recursive: true, force: true }); break; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
}

const cards = variants.map((v, i) => `
      <li class="card">
        <a class="shot" href="${v.dir}/index.html"><img src="${v.dir}/preview.jpg" width="${previewWidth}" height="${previewHeight}" alt="Скриншот варианта «${escapeHtml(v.title)}»" loading="${i === 0 ? 'eager' : 'lazy'}"></a>
        <div class="body">
          <div class="num">${String(i + 1).padStart(2, '0')}</div>
          <h2>${escapeHtml(v.title)}</h2>
          <p>${escapeHtml(v.description)}</p>
          <div class="tags">${v.tags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
          <a class="btn" href="${v.dir}/index.html">Открыть вариант</a>
        </div>
      </li>`).join('');

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Варианты главной — Ямобур</title>
<style>
:root{--ink:#14161a;--muted:#5f6672;--line:#dfe2e7;--bg:#f3f4f2;--white:#fff;--accent:#d9481f}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.55 "Segoe UI",system-ui,sans-serif}
a{color:inherit}
img{display:block;max-width:100%}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}
.top{border-bottom:1px solid var(--line);background:var(--white)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}
.top a{text-decoration:none;font-size:14px;min-height:44px;display:inline-flex;align-items:center}
.top .mark{font-family:ui-monospace,Consolas,monospace;font-size:11px;letter-spacing:.12em;color:var(--muted)}
main{padding:56px 0 72px}
h1{font-size:clamp(30px,4vw,46px);letter-spacing:-.03em;line-height:1.05;max-width:18ch}
.lead{margin-top:16px;max-width:64ch;color:var(--muted);font-size:17px}
.cards{list-style:none;display:grid;gap:28px;margin-top:44px}
.card{display:grid;grid-template-columns:1.15fr .85fr;background:var(--white);border:1px solid var(--line);overflow:hidden}
.shot{display:block;border-right:1px solid var(--line);background:#e9eae7;min-height:300px}
.shot img{width:100%;height:100%;object-fit:cover;object-position:top center;transition:transform .3s}
.card:hover .shot img{transform:scale(1.015)}
.body{padding:30px 32px;display:flex;flex-direction:column;align-items:flex-start;gap:14px}
.num{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--accent);letter-spacing:.1em}
h2{font-size:26px;letter-spacing:-.025em;line-height:1.15}
.body p{font-size:15px;color:var(--muted)}
.tags{display:flex;flex-wrap:wrap;gap:8px}
.tags span{font-size:12px;border:1px solid var(--line);padding:4px 10px;color:var(--muted)}
.btn{margin-top:auto;display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;font-size:15px}
.btn:hover{background:var(--accent)}
.note{margin-top:40px;font-size:13px;color:var(--muted);max-width:70ch}
footer{border-top:1px solid var(--line);padding:24px 0;font-size:13px;color:var(--muted)}
@media(max-width:860px){
  .card{grid-template-columns:1fr}
  .shot{border-right:0;border-bottom:1px solid var(--line);min-height:0}
  .shot img{height:auto}
  .body{padding:24px}
}
@media(max-width:560px){
  .wrap{padding:0 18px}
  main{padding:36px 0 52px}
  .body{padding:20px 18px}
}
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a href="../index.html">← на сайт</a>
    <span class="mark">внутренняя страница · noindex</span>
  </div>
</header>
<main class="wrap">
  <h1>Варианты главной страницы</h1>
  <p class="lead">Несколько направлений оформления на одном и том же контенте. Скриншоты сняты на ширине 1440 px, каждый вариант — отдельный статичный файл: можно открыть, пролистать и сравнить на телефоне. Список собирается по папкам <code>site/design/</code>, поэтому количество вариантов может быть любым.</p>
  <ol class="cards">${cards}
  </ol>
  <p class="note">Страница собрана скриптом <code>tools/build-design.mjs</code>. Чтобы добавить вариант, положите папку с <code>index.html</code> и <code>meta.json</code> в <code>site/design/</code> и запустите сборку заново.</p>
</main>
<footer><div class="wrap">Ямобур-вездеход · варианты дизайна · ${new Date().toISOString().slice(0, 10)}</div></footer>
</body>
</html>
`;

writeFileSync(join(designDir, 'index.html'), html);
console.log(`index: ${variants.length} варианта`);
