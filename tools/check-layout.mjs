#!/usr/bin/env node
// Проверка вёрстки без зависимостей: Node 22+ (встроенные fetch и WebSocket) и установленный Chrome/Edge.
//
// Запуск:
//   node tools/check-layout.mjs
//   node tools/check-layout.mjs https://yamobur-vezdehod.ru/ --json
//   node tools/check-layout.mjs http://localhost/yamobur/site/ --widths 390,768,1440
//
// Что проверяет на каждой ширине:
//   - горизонтальное переполнение и элементы за границей вьюпорта;
//   - тап-таргеты меньше 44 px;
//   - наложения заголовков на следующий блок;
//   - высоту sticky-шапки и открытого меню;
//   - длину строки в статье;
//   - контраст текста и фона у ключевых элементов.
//
// Порог контраста — WCAG AA: 4.5:1, для крупного текста (>= 24 px или >= 18.66 px bold) — 3:1.
// Код возврата 1, если есть переполнение, наложения или контраст ниже AA.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//.test(a)) ?? 'https://yamobur-vezdehod.ru/';
const json = args.includes('--json');
const widthsArg = args[args.indexOf('--widths') + 1];
const widths = args.includes('--widths') && widthsArg ? widthsArg.split(',').map(Number) : [390, 768, 1440];

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
      const key = `${msg.sessionId ?? ''}:${msg.method}`;
      for (const fn of this.listeners.get(key) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(method, sessionId, timeout = 15000) {
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

function measure() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const rect = el => el.getBoundingClientRect();
  const out = { width: vw, overflowX: de.scrollWidth - vw, scrollHeight: de.scrollHeight };

  out.outside = [...document.querySelectorAll('body *')]
    .filter(el => {
      const r = rect(el);
      if (!(r.width > 0 && (r.right > vw + 1 || r.left < -1))) return false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return false;
      }
      return true;
    })
    .slice(0, 10)
    .map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), left: Math.round(rect(el).left), right: Math.round(rect(el).right) }));

  const targets = [...document.querySelectorAll('a, button, [role="button"]')]
    .map(el => ({ text: (el.textContent || '').trim().slice(0, 40), w: Math.round(rect(el).width), h: Math.round(rect(el).height) }))
    .filter(t => t.w > 0 && t.h > 0);
  out.smallTargets = { total: targets.length, small: targets.filter(t => t.h < 44).length, sample: targets.filter(t => t.h < 44).slice(0, 8) };

  out.overlaps = [...document.querySelectorAll('h1, h2, h3, h4')].map(h => {
    const next = h.nextElementSibling;
    if (!next) return null;
    const a = rect(h), b = rect(next);
    const dy = Math.round(a.bottom - b.top);
    const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return dy > 0 && dx > 0 ? { heading: h.textContent.trim().slice(0, 60), overlapPx: dy } : null;
  }).filter(Boolean);

  const header = document.querySelector('.site-header');
  if (header) {
    const cs = getComputedStyle(header);
    out.header = { height: Math.round(rect(header).height), position: cs.position };
    const toggle = document.querySelector('.nav-toggle');
    if (toggle && getComputedStyle(toggle).display !== 'none') {
      toggle.click();
      out.header.openHeight = Math.round(rect(header).height);
      out.header.toggleAriaExpanded = toggle.getAttribute('aria-expanded');
    }
  }

  const p = document.querySelector('.article p');
  if (p) {
    const fs = parseFloat(getComputedStyle(p).fontSize);
    const w = rect(p).width;
    out.article = { textWidth: Math.round(w), fontSize: fs, charsPerLine: Math.round(w / (fs * 0.5)) };
  }

  const parseColor = c => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const luminance = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const opaqueBg = el => {
    for (let node = el; node; node = node.parentElement) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const pairs = [
    ['.btn', 'кнопка'],
    ['.btn-outline', 'кнопка-контур'],
    ['.price', 'цена'],
    ['.section-sub', 'подзаголовок секции'],
    ['.more', 'ссылка «Подробнее»'],
    ['.article p', 'текст статьи'],
  ];
  out.contrast = pairs.map(([selector, label]) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const fg = parseColor(getComputedStyle(el).color);
    if (!fg) return null;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return { label, selector, skipped: 'фон — картинка или градиент' };
      const bgc = parseColor(style.backgroundColor);
      if (bgc && bgc.a > 0.95) break;
    }
    const bg = opaqueBg(el);
    const l1 = luminance(fg), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const style = getComputedStyle(el);
    const [size, weight] = [parseFloat(style.fontSize), parseInt(style.fontWeight, 10) || 400];
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return { label, selector, ratio: Math.round(ratio * 100) / 100, required: large ? 3 : 4.5, fontSize: size, fontWeight: weight };
  }).filter(Boolean);

  return out;
}

const profileDir = mkdtempSync(join(tmpdir(), 'layout-check-'));
const port = await freePort();
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp;
let failed = false;

try {
  cdp = new CDP(await waitForDebugger(port));
  await cdp.ready;

  const results = [];
  for (const width of widths) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: width <= 480 ? 2 : 1,
      mobile: width <= 480, screenWidth: width, screenHeight: 900,
    }, sessionId);
    if (width <= 480) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId);

    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(${measure.toString()})()`, returnByValue: true, awaitPromise: true,
    }, sessionId);

    results.push({ width, ...result.value });
    await cdp.send('Target.closeTarget', { targetId });
  }

  if (json) {
    console.log(JSON.stringify({ url, results }, null, 2));
  } else {
    console.log(`\n${url}\n`);
    for (const r of results) {
      const menu = r.header?.openHeight ? `, меню ${r.header.openHeight} px` : '';
      console.log(`—— ${r.width} px ——`);
      console.log(`переполнение: ${r.overflowX} px, высота страницы: ${r.scrollHeight} px`);
      if (r.outside.length) console.log(`за границей: ${r.outside.map(x => `${x.tag}.${x.cls} (${x.left}..${x.right})`).join('; ')}`);
      if (r.smallTargets.small) console.log(`тап-таргеты < 44 px: ${r.smallTargets.small} из ${r.smallTargets.total}`);
      if (r.overlaps.length) console.log(`наложения: ${r.overlaps.map(o => `«${o.heading}» на ${o.overlapPx} px`).join('; ')}`);
      if (r.header) console.log(`шапка: ${r.header.height} px${menu}${r.header.toggleAriaExpanded === null ? ', нет aria-expanded' : ''}`);
      if (r.article) console.log(`статья: ${r.article.textWidth} px, ~${r.article.charsPerLine} символов в строке`);
      for (const c of r.contrast) {
        const mark = c.ratio < c.required ? '!!' : 'ok';
        console.log(`${mark} ${c.label}: ${c.ratio}:1 (нужно ${c.required}:1, ${c.fontSize} px)`);
      }
      console.log('');
    }
  }

  failed = results.some(r => r.overflowX > 0 || r.overlaps.length > 0 || r.contrast.some(c => c.ratio < c.required));
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

process.exitCode = failed ? 1 : 0;
