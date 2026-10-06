// Browser tests with Playwright + Chromium. Run: node tests/e2e.test.mjs (after npm run build)
//
// Chromium path: $CHROME_PATH, else /opt/pw-browsers/chromium, else installed Google Chrome.
// No real model is downloaded here. The AI path is exercised with fake workers
// that speak the same message protocol as src/ll-worker.js. Session recording is
// checked with the real Microsoft Clarity library (clarity-js, devDependency).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../scripts/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { core } = require(path.join(ROOT, 'src', 'll-assistant.js'));
const { checkQuestion } = require(path.join(ROOT, 'tests', 'check.js'));
const CLARITY_JS = require.resolve('clarity-js/build/clarity.min.js');
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8')));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const URL_OF = Object.fromEntries(source.games.map((g) => [g.id, g.url]));
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = `${BASE}/demo.html`;
const EVENTS = ['ll_ai_offered', 'll_download_started', 'll_download_finished', 'll_fallback_shown', 'll_game_click'];
const TOKENS = Object.fromEntries((fs.readFileSync(path.join(ROOT, 'll-tokens.css'), 'utf8').match(/--[a-z0-9-]+:[^;]+/gi) || []).map((d) => [d.split(':')[0].slice(2), d.split(':').slice(1).join(':').trim()]));

let server, browser;

before(async () => {
  server = await startServer(PORT);
  const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({
    executablePath: exe, channel: exe ? undefined : 'chrome', headless: true,
    args: ['--disable-features=WebGPU', '--disable-gpu', '--no-sandbox'],
  });
});
after(async () => { await browser?.close(); server?.close(); });

// ---------- helpers ----------

async function newPage({ fakeGpu = false, noGpuObject = false, ua, worker, viewport, demoPatch } = {}) {
  const context = await browser.newContext({ ...(ua ? { userAgent: ua } : {}), ...(viewport ? { viewport } : {}) });
  const requests = [];
  context.on('request', (r) => requests.push({ url: r.url(), t: Date.now() }));
  await context.route('https://ladderlessons.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>game page</p>' }));
  // The model host is never really contacted in these tests.
  await context.route(/huggingface\.co|githubusercontent\.com|fonts\.g/, (r) => {
    const u = r.request().url();
    if (u.endsWith('tensor-cache.json')) {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 200 * 1048576 }, { dataPath: 'params_shard_1.bin', nbytes: 80 * 1048576 }] }) });
    }
    if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'content-length': '5000000' }, body: '' });
    return r.abort();
  });
  if (worker) await context.route('**/ll-worker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: worker }));
  if (demoPatch) {
    await context.route('**/demo.html*', async (r) => {
      const body = fs.readFileSync(path.join(ROOT, 'demo.html'), 'utf8');
      r.fulfill({ contentType: 'text/html', body: demoPatch(body) });
    });
  }
  await context.addInitScript(({ fakeGpu, noGpuObject }) => {
    if (noGpuObject) { try { delete Navigator.prototype.gpu; } catch (e) { /* ignore */ } }
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* ignore */ }
    window.__opened = [];
    window.open = function (url) { window.__opened.push(String(url)); return null; };
    if (fakeGpu) {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: {}, info: {} }) } });
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    }
  }, { fakeGpu, noGpuObject });
  const page = await context.newPage();
  const errors = [], consoleText = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => consoleText.push(m.text()));
  return { context, page, requests, errors, consoleText };
}

async function openWidget(page, url = DEMO) {
  await page.goto(url);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => { const s = LLAssistant.internals.state().ai; return s !== 'unknown' && s !== 'checking'; });
}

const lastBot = (page) => page.locator('#ll-assistant .ll-bot:not(.ll-thinking):not(.ll-intro)').last();

async function ask(page, text) {
  const before = await page.evaluate(() => LLAssistant.internals.turns().length);
  await page.locator('#ll-assistant .ll-input').fill(text);
  await page.locator('#ll-assistant .ll-input').press('Enter');
  await page.waitForFunction((n) => LLAssistant.internals.turns().length >= n + 2, before);
  const turns = await page.evaluate(() => LLAssistant.internals.turns());
  return { turn: turns[turns.length - 1], el: lastBot(page), text: await lastBot(page).innerText() };
}

const calls = (page) => page.evaluate(() => ({ gtag: window.__events, clarity: window.__clarity }));
const eventNames = async (page) => (await calls(page)).gtag.map((a) => a[1]);

const rgb = (hex) => { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
const TIER_LABEL = { en: { free: 'Free', parent: 'Parent', teacher: 'Teacher' }, zh: { free: '免費', parent: '家長版', teacher: '老師版' } };
const TIER_BG = { free: rgb(TOKENS['tier-free']), parent: rgb(TOKENS.yellow), teacher: rgb(TOKENS['purple-1']) };

// Query words and Chinese pairs, for leak checks.
function queryTokens(text) {
  const words = (text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[a-z0-9]{2,}/g) || []).filter((w) => !/^\d+$/.test(w) && !['ll', 'll_assistant'].includes(w));
  const zh = (text.match(/[㐀-鿿]+/g) || []).flatMap((run) => { const out = []; for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2)); return out; });
  return [...new Set([...words, ...zh])];
}

// Whole-word match for Latin tokens ("form" must not match "platform"); plain substring for Chinese.
function containsToken(haystack, tok) {
  if (/[㐀-鿿]/.test(tok)) return haystack.includes(tok);
  return new RegExp('(^|[^a-z0-9])' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i').test(haystack);
}

// Same as clarity-js src/core/hash.ts
function clarityHash(input, precision) {
  let h1 = 5381, h2 = 5381;
  for (let i = 0; i < input.length; i += 2) {
    h1 = ((h1 << 5) + h1) ^ input.charCodeAt(i);
    if (i + 1 < input.length) h2 = ((h2 << 5) + h2) ^ input.charCodeAt(i + 1);
  }
  const h = Math.abs(h1 + h2 * 11579);
  return (precision ? h % Math.pow(2, precision) : h).toString(36);
}

// A worker that behaves like ll-worker.js but answers instantly. Markers in the
// teacher's message choose the behaviour; they are not words the parser knows.
const FAKE_WORKER = `
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    let p = 0;
    const t = setInterval(() => { p += 0.25; postMessage({ type: 'progress', progress: Math.min(p, 1), text: '' });
      if (p >= 1) { clearInterval(t); postMessage({ type: 'ready', ms: 5 }); } }, 30);
  } else if (m.type === 'chat') {
    const user = m.messages[m.messages.length - 1].content;
    const cands = JSON.parse(m.messages[0].content.split('CANDIDATES: ')[1]);
    const s = m.schema;
    if (/qqcrash/.test(user)) { setTimeout(() => { throw new Error('GPU device lost'); }); return; }
    let picks = ['not_a_game', cands[0].id, 'https://evil.example.com'];
    if (/qqkid/.test(user)) picks = cands.filter((c) => c.kid_theme).map((c) => c.id).slice(0, 3);
    if (/qqone/.test(user)) picks = [cands.filter((c) => !c.free).pop().id];
    let text = JSON.stringify({ picks });
    if (/qqbad/.test(user)) text = 'Sure! Visit https://evil.example.com for free games.';
    if (/qqask/.test(user) && s.anyOf) text = JSON.stringify({ ask: 'Visit https://evil.example.com. How old? 1) 4-6 2) Adults' });
    postMessage({ type: 'reply', id: m.id, text, ms: 3 });
  }
};`;

const SLOW_WORKER = `
self.onmessage = (e) => {
  if (e.data.type !== 'load') return;
  let p = 0;
  setInterval(() => { p = Math.min(p + 0.01, 0.99); postMessage({ type: 'progress', progress: p, text: '' }); }, 40);
};`;

// ---------- tests ----------

test('Keyword mode (WebGPU off): page load, header, every fixed question, cards, links, tags', async () => {
  const { context, page, requests, errors } = await newPage();
  await page.goto(DEMO);
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);

  assert.equal(await page.evaluate(async () => !navigator.gpu || !(await navigator.gpu.requestAdapter())), true, 'WebGPU should be off in this test');
  const loadPaths = requests.map((r) => new URL(r.url).pathname).filter((p) => !p.endsWith('/demo.html'));
  assert.deepEqual(loadPaths.sort(), ['/dist/ll-assistant/ll-assistant.css', '/dist/ll-assistant/ll-assistant.js'], 'page load fetched more than the widget script and CSS');
  assert.equal(await page.evaluate(() => window.__cls), 0, 'layout shift');
  assert.equal(await page.locator('#ll-assistant').getAttribute('data-clarity-mask'), 'true');
  assert.equal(await page.locator('#ll-assistant').evaluate((b) => getComputedStyle(b).position), 'fixed');

  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().device.reason), 'no-gpu-adapter');
  assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false, 'no AI offer without WebGPU');
  assert.equal(await page.locator('#ll-assistant .ll-privacy').innerText(), 'Runs in your browser. What you type is not sent to us.');
  assert.equal(await page.locator('#ll-assistant .ll-modeline').innerText(), 'Matches by keyword.');
  assert.equal(await page.locator('#ll-assistant .ll-privacy svg').getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(await page.locator('#ll-assistant .ll-panel').innerText(), /sorry|error|not supported|unavailable/i);

  let lang = 'en';
  for (const q of questions) {
    if (q.expect === 'nothing-sent') {
      const n = await page.locator('#ll-assistant .ll-you').count();
      await page.locator('#ll-assistant .ll-input').fill(q.text);
      assert.equal(await page.locator('#ll-assistant .ll-send').isDisabled(), true);
      await page.locator('#ll-assistant .ll-input').press('Enter');
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#ll-assistant .ll-you').count(), n, 'empty message must not be sent');
      continue;
    }
    lang = core.messageLang(q.text) || lang;
    const { turn, el, text } = await ask(page, q.text);
    const check = checkQuestion({ ...q, parseAge: undefined }, turn, cat);
    assert.ok(check.ok, `${q.id}: ${check.fails.join('; ')}`);
    assert.equal(turn.source, 'rules');
    assert.ok(!text.includes('evil.example'), 'injected URL rendered');
    assert.equal(await page.locator('#ll-assistant .ll-title').innerText(), lang === 'zh' ? '課堂遊戲小助手' : 'Lesson game finder', `${q.id}: label language`);
    if (turn.kind !== 'picks') continue;

    // Cards: names from the catalogue, plan label wording and colour, mode tag, no "How to run it".
    const cards = await el.locator('.ll-card').evaluateAll((cs) => cs.map((c) => ({
      name: (c.querySelector('.ll-card-title, .ll-card-name').textContent || '').replace(/\s*↗\s*$/, ''),
      tier: c.querySelector('.ll-tier').textContent, bg: getComputedStyle(c.querySelector('.ll-tier')).backgroundColor,
      tags: [...c.querySelectorAll('.ll-tag')].map((t) => t.textContent), how: !!c.querySelector('.ll-how'),
      levels: [...c.querySelectorAll('.ll-tags .ll-chip')].map((b) => b.textContent.replace(/\s*↗\s*$/, '')),
    })));
    assert.equal(cards.length, turn.items.length);
    turn.items.forEach((it, i) => {
      const g = cat.byId[it.ids ? it.ids[0] : it.id];
      assert.equal(cards[i].name, it.ids ? 'Ladder Vocabulary' : g.title, q.id);
      assert.equal(cards[i].tier, TIER_LABEL[lang][g.tier], `${q.id}: plan label`);
      assert.equal(cards[i].bg, TIER_BG[g.tier], `${q.id}: plan colour`);
      assert.ok(cards[i].tags.includes(lang === 'zh' ? { led: '老師帶領', solo: '學生自己玩' }[g.mode] : { led: 'Teacher-led', solo: 'Student solo' }[g.mode]), `${q.id}: mode tag`);
      assert.equal(cards[i].how, false, 'no how-to-run line without a per-game value');
      if (it.kid) assert.ok(cards[i].tags.includes(lang === 'zh' ? '兒童主題' : 'Kid-themed'), `${q.id}: kid tag`);
      if (it.ids) assert.deepEqual(cards[i].levels, it.ids.map((id) => cat.byId[id].level_min), `${q.id}: one link per level`);
      if (!it.ids && cat.byId[it.id].level_min) assert.ok(cards[i].tags.some((t) => /A1|A2|B1|B2|C1|C2/.test(t)), `${q.id}: level tag`);
    });
    if (turn.kidNote) assert.equal(await el.locator('.ll-cards > li.ll-small').count(), 1);
  }

  // Each game button opens its catalogue URL, and only that.
  const lastPicks = (await page.evaluate(() => LLAssistant.internals.turns())).filter((t) => t.kind === 'picks').pop();
  const buttons = lastBot(page).locator('button.ll-card-title, .ll-card .ll-chip');
  for (let i = 0; i < await buttons.count(); i++) await buttons.nth(i).click();
  const opened = await page.evaluate(() => window.__opened);
  assert.deepEqual(opened, lastPicks.ids.map((id) => URL_OF[id]));
  assert.ok((await eventNames(page)).includes('ll_game_click'));

  // Nothing in the widget's DOM names a game or the language typed (7B).
  const dom = await page.evaluate(() => {
    const r = document.getElementById('ll-assistant');
    return {
      hrefs: r.querySelectorAll('a[href]').length, forms: r.querySelectorAll('form').length,
      ids: r.querySelectorAll('[data-id],[data-source],[data-n],[lang]').length,
      tierCodes: [...new Set([...r.querySelectorAll('.ll-tier')].map((t) => t.getAttribute('data-t')))].sort(),
      classes: [...new Set([...r.querySelectorAll('*')].flatMap((n) => [...n.classList]))],
    };
  });
  assert.equal(dom.hrefs, 0, 'no link addresses');
  assert.equal(dom.forms, 0, 'no <form>');
  assert.equal(dom.ids, 0, 'no ids, sources or lang attributes');
  assert.ok(dom.tierCodes.every((c) => ['1', '2', '3'].includes(c)));
  assert.ok(!dom.classes.some((c) => /free|parent|teacher|phonics|vocab|grammar|speaking|kid|level|note|name|zh|en$/i.test(c)), 'class names carry no game data: ' + dom.classes.join(' '));

  // Email gate: widget hides while it is visible.
  await page.locator('#ll-assistant .ll-close').click();
  await page.locator('#gate').click();
  await page.waitForFunction(() => document.getElementById('ll-assistant').hidden);
  await page.locator('#gate-close').click();
  await page.waitForFunction(() => !document.getElementById('ll-assistant').hidden);

  assert.ok(!requests.some((r) => /ll-worker\.js|web-llm\.js|huggingface|githubusercontent/.test(r.url)), 'no model code or weights requested');
  assert.deepEqual(errors, []);
  await context.close();
});

test('E2: analytics carry nothing from the conversation, and nothing leaves the page after typing', async () => {
  const { context, page, requests, errors, consoleText } = await newPage();
  await openWidget(page);
  const startUrl = page.url();
  for (const q of questions) {
    if (q.expect === 'nothing-sent') continue;
    const n0 = requests.length;
    await page.locator('#ll-assistant .ll-input').click();
    await page.keyboard.type(q.text, { delay: 0 });
    await page.locator('#ll-assistant .ll-send').click();
    await page.waitForFunction(() => LLAssistant.internals.turns().length % 2 === 0 && !document.querySelector('#ll-assistant .ll-thinking'));
    const tl = await lastBot(page).locator('button.ll-card-title').count();
    if (tl) await lastBot(page).locator('button.ll-card-title').first().click();
    assert.equal(requests.length, n0, `${q.id}: network request after typing: ${requests.slice(n0).map((r) => r.url).join(', ')}`);
  }
  const { gtag, clarity } = await calls(page);
  assert.ok(gtag.length > 0);
  for (const c of gtag) assert.deepEqual(c, ['event', c[1], { event_category: 'll_assistant' }]);
  for (const c of gtag) assert.ok(EVENTS.includes(c[1]), c[1]);
  for (const c of clarity) { assert.equal(c.length, 2); assert.equal(c[0], 'event'); assert.ok(EVENTS.includes(c[1]), c[1]); }
  // Every payload already equals the fixed object; anything else would show up here.
  const params = JSON.stringify(gtag.map((c) => c[2])).replace(/"event_category":"ll_assistant"/g, '');
  for (const q of questions) for (const tok of queryTokens(q.text)) assert.ok(!containsToken(params, tok), `${q.id}: "${tok}" in an analytics payload`);
  assert.equal(page.url(), startUrl, 'URL unchanged');
  const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  assert.ok(storage.local.every((k) => /^ll-ai-bytes:/.test(k)), storage.local.join());
  assert.deepEqual(storage.session, []);
  // Chrome's own WebGPU notices are the only console lines allowed.
  const logs = consoleText.concat(errors).filter((l) => !/WebGPU/.test(l)).join('\n');
  assert.equal(logs, '', 'the widget writes nothing to the console');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Microsoft Clarity (real library) records the widget without the text, hash or links (7B)', async () => {
  const { context, page } = await newPage();
  await context.addInitScript(() => {
    window.__up = [];
    window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    window.clarity('start', { projectId: 'll-test', delay: 100, upload: (p) => window.__up.push(typeof p === 'string' ? p : JSON.stringify(p)) });
  });
  // A bare page: only the widget can put words into the recording. (demo.html's
  // visible tiles and its logging clarity() stub are left out.)
  await context.route('**/clarity-page.html', (r) => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><p>x</p>' +
    '<script src="/dist/ll-assistant/ll-assistant.js" defer></script></body></html>' }));
  await page.goto(`${BASE}/clarity-page.html`);
  await page.addScriptTag({ path: CLARITY_JS });
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  // Words already in the recording before anything is typed (tag and attribute
  // names such as "link") are page structure, not leaks.
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.clarity('upgrade', 'baseline'));
  await page.waitForTimeout(600);
  const baseline = await page.evaluate(() => window.__up.join('\n'));
  assert.ok(baseline.length > 500, 'Clarity recorded the page');
  const asked = questions.filter((q) => q.expect !== 'nothing-sent').slice(0, 24);
  for (const q of asked) {
    await page.locator('#ll-assistant .ll-input').click();
    await page.keyboard.type(q.text, { delay: 0 });
    await page.locator('#ll-assistant .ll-send').click();  // mouse click: the text box loses focus first
    await page.waitForFunction(() => LLAssistant.internals.turns().length % 2 === 0);
    const title = lastBot(page).locator('button.ll-card-title, .ll-card .ll-chip');
    if (await title.count()) await title.first().click();
  }
  await page.locator('#ll-assistant .ll-input').click();
  await page.keyboard.type('Primary 5 student vocabulary');
  await page.locator('#ll-assistant .ll-close').click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.clarity('upgrade', 'test'));
  await page.waitForTimeout(800);
  // The five fixed event names (for example ll_game_click) are meant to be there.
  const uploads = (await page.evaluate(() => window.__up.join('\n'))).replace(/ll_(ai_offered|download_started|download_finished|fallback_shown|game_click)/g, '');
  assert.ok(uploads.length > 1000, 'Clarity uploaded something');
  assert.ok(!uploads.includes('ladderlessons.com'), 'a game link reached Clarity');
  for (const q of asked) {
    assert.ok(!uploads.includes('"' + clarityHash(q.text, 28) + '"'), `${q.id}: hash of the typed text reached Clarity`);
    for (const tok of queryTokens(q.text).filter((t) => t.length >= 3 || /[㐀-鿿]/.test(t))) {
      if (containsToken(baseline, tok)) continue;
      assert.ok(!containsToken(uploads, tok), `${q.id}: "${tok}" reached Clarity`);
    }
  }
  for (const g of source.games) assert.ok(!uploads.includes(g.title), `game title ${g.title} reached Clarity`);
  assert.ok(!/vocab_|phonics_|speaking_|grammar_/.test(uploads), 'a game id reached Clarity');
  await context.close();
});

test('Clarity pause mode (data-clarity="pause"): paused while open, conversation cleared before it resumes', async () => {
  const { context, page } = await newPage({ demoPatch: (b) => b.replace('defer data-avoid="#email-gate"', 'defer data-avoid="#email-gate" data-clarity="pause"') });
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.evaluate(() => {
    const orig = window.clarity;
    window.__atResume = null;
    window.clarity = function (cmd) {
      if (cmd === 'resume') window.__atResume = { msgs: document.querySelectorAll('#ll-assistant .ll-msg').length, input: document.querySelector('#ll-assistant .ll-input').value, title: document.querySelector('#ll-assistant .ll-title').textContent };
      return orig.apply(this, arguments);
    };
  });
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  await ask(page, '小五學生 生字');
  await page.locator('#ll-assistant .ll-input').fill('draft text');
  await page.locator('#ll-assistant .ll-close').click();
  const { clarity } = await calls(page);
  const cmds = clarity.map((c) => c[0]);
  assert.ok(cmds.indexOf('pause') >= 0 && cmds.lastIndexOf('resume') > cmds.indexOf('pause'));
  assert.deepEqual(await page.evaluate(() => window.__atResume), { msgs: 0, input: '', title: 'Lesson game finder' });
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => document.querySelectorAll('#ll-assistant .ll-card').length > 0);
  assert.equal(await page.locator('#ll-assistant .ll-title').innerText(), '課堂遊戲小助手', 'conversation and language come back on reopen');
  await context.close();
});

test('C1: one language per conversation; a switch redraws earlier answers; "2" keeps the language', async () => {
  const { context, page } = await newPage();
  await openWidget(page);
  await ask(page, 'Primary 5 student vocabulary');
  assert.equal(await page.locator('#ll-assistant .ll-card .ll-tier').first().innerText(), 'Parent');
  const r = await ask(page, '中四學生');
  assert.equal(r.turn.askType, 'skill');
  assert.equal(await page.locator('#ll-assistant .ll-card .ll-tier').first().innerText(), '家長版', 'earlier card redrawn in Chinese');
  assert.equal(await page.locator('#ll-assistant .ll-title').innerText(), '課堂遊戲小助手');
  assert.match(await lastBot(page).innerText(), /1\s*口語[\s\S]*2\s*寫作[\s\S]*6\s*聽力/);
  const r2 = await ask(page, '2');
  assert.equal(await page.locator('#ll-assistant .ll-title').innerText(), '課堂遊戲小助手', '"2" keeps Chinese');
  assert.equal(r2.turn.kind, 'picks');
  assert.ok(r2.turn.ids.every((id) => cat.byId[id].skill === 'writing'), r2.turn.ids.join());
  assert.ok(!cat.byId[r2.turn.ids[0]].kid, 'Form 4: kid-themed not first');
  await ask(page, 'adult business english');
  assert.equal(await page.locator('#ll-assistant .ll-card .ll-tier').first().innerText(), 'Parent', 'switched back to English');
  await context.close();
});

test('Choices: skill question, reading and age questions answer by click', async () => {
  const { context, page } = await newPage();
  await openWidget(page);
  let r = await ask(page, 'Form 4 student');
  assert.equal(r.turn.askType, 'skill');
  await r.el.locator('.ll-chip', { hasText: 'Speaking' }).click();
  await page.waitForFunction(() => LLAssistant.internals.turns().length === 4);
  let t = (await page.evaluate(() => LLAssistant.internals.turns())).pop();
  assert.equal(t.kind, 'picks');
  assert.ok(!cat.byId[t.ids[0]].kid);
  assert.ok(!t.ids.includes('speaking_IeltsSpeakingRoom'));
  r = await ask(page, '9 year old reading');
  assert.equal(r.turn.askType, 'reading');
  assert.match(r.text, /There is no reading game yet/);
  assert.doesNotMatch(r.text, /Phonics/);
  await r.el.locator('.ll-chip', { hasText: 'Vocabulary' }).click();
  await page.waitForFunction(() => LLAssistant.internals.turns().length === 8);
  t = (await page.evaluate(() => LLAssistant.internals.turns())).pop();
  assert.equal(t.kind, 'picks');
  assert.ok(t.ids.some((id) => cat.byId[id].skill === 'vocab'));
  r = await ask(page, '5 year old grammar');
  assert.equal(r.turn.askType, 'noGames');
  assert.match(r.text, /Grammar games start at age 8/);
  await context.close();
});

test('Narrow screens: panel fits, no sideways scroll, input and button on one row', async () => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 768, height: 1024 }]) {
    const { context, page } = await newPage({ viewport });
    await openWidget(page);
    await ask(page, 'Form 4 Hong Kong student, speaking');
    const m = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const p = box('#ll-assistant .ll-panel'), i = box('#ll-assistant .ll-input'), b = box('#ll-assistant .ll-send'), l = box('#ll-assistant .ll-log');
      return { p, i, b, l, sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight, fs: getComputedStyle(document.querySelector('#ll-assistant .ll-input')).fontSize };
    });
    const tag = `${viewport.width}x${viewport.height}`;
    assert.ok(m.p.left >= 0 && m.p.right <= m.iw && m.p.top >= 0 && m.p.bottom <= m.ih, `${tag}: panel outside the screen`);
    assert.ok(m.sw <= m.iw, `${tag}: sideways scroll`);
    assert.ok(m.l.height >= 150, `${tag}: conversation area only ${m.l.height}px`);
    assert.ok(m.b.top < m.i.bottom && m.b.bottom > m.i.top, `${tag}: input and button not on one row`);
    assert.equal(m.fs, '16px');
    await context.close();
  }
});

test('Browser without navigator.gpu at all (older Safari / Firefox) gets the fallback', async () => {
  const { context, page } = await newPage({ noGpuObject: true });
  await openWidget(page);
  assert.equal(await page.evaluate(() => 'gpu' in navigator), false);
  const st = await page.evaluate(() => LLAssistant.internals.state());
  assert.equal(st.ai, 'rules');
  assert.equal(st.device.reason, 'no-webgpu');
  const r = await ask(page, 'Adult, B2, IELTS speaking');
  assert.ok(r.turn.ids.includes('speaking_IeltsSpeakingRoom'));
  await context.close();
});

test('Phone and in-app browser user agents never get the AI offer', async () => {
  const uas = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0',
    androidWebview: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36',
  };
  for (const [name, ua] of Object.entries(uas)) {
    const { context, page } = await newPage({ fakeGpu: true, ua });
    await openWidget(page);
    assert.equal((await page.evaluate(() => LLAssistant.internals.state())).ai, 'rules', name);
    assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false, name);
    const r = await ask(page, 'Age 6 phonics');
    assert.ok(r.turn.ids.length > 0, name);
    await context.close();
  }
});

test('Capable device: size shown, nothing downloads before the click, failed download falls back and keeps the draft', async () => {
  const { context, page, requests } = await newPage({ fakeGpu: true });
  await openWidget(page);
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  const btn = page.locator('#ll-assistant .ll-offer .ll-cta');
  const label = await btn.innerText();
  assert.match(label, /^Download AI · \d+ MB · one-time download$/);
  assert.ok(Number(label.match(/(\d+) MB/)[1]) >= 280, label);
  assert.ok((await eventNames(page)).includes('ll_ai_offered'));
  await page.waitForTimeout(300);
  assert.ok(!requests.some((r) => /ll-worker\.js|web-llm\.js|params_shard|mlc-chat-config/.test(r.url)), 'downloaded before the click');

  // Real worker + real WebLLM, but the GPU is off and the model host is blocked: load must fail.
  await page.locator('#ll-assistant .ll-input').fill('Age 7, phonics, 30 min');
  await btn.click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'failed', null, { timeout: 30000 });
  assert.ok(requests.some((r) => r.url.endsWith('/ll-worker.js')));
  assert.ok(requests.some((r) => r.url.endsWith('/vendor/web-llm.js')));
  assert.equal(await page.locator('#ll-assistant .ll-input').inputValue(), 'Age 7, phonics, 30 min', 'draft kept');
  assert.equal(await page.locator('#ll-assistant .ll-modeline').innerText(), 'Matches by keyword.');
  const ev = await eventNames(page);
  assert.ok(ev.includes('ll_download_started') && ev.includes('ll_fallback_shown'));
  assert.ok(!ev.includes('ll_download_finished'));
  const r = await ask(page, 'Age 7, phonics, 30 min');
  assert.equal(r.turn.source, 'rules');
  assert.ok(r.turn.ids.length > 0);
  await context.close();
});

test('Download shows progress and can be cancelled', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: SLOW_WORKER });
  await openWidget(page);
  await page.locator('#ll-assistant .ll-offer .ll-cta').click();
  await page.waitForFunction(() => /Downloading AI · [1-9]\d?% · \d+ of \d+ MB/.test(document.querySelector('#ll-assistant .ll-progress-text')?.textContent || ''));
  assert.ok(await page.locator('#ll-assistant .ll-bar span').evaluate((s) => parseFloat(s.style.width)) > 0);
  await page.locator('#ll-assistant .ll-offer button', { hasText: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-cta').isVisible(), true);
  await context.close();
});

test('AI mode (fake model): free-first, lesson length, kid-themed order, fixed question, bad output, crash', async () => {
  const { context, page, errors } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await openWidget(page);
  await page.locator('#ll-assistant .ll-offer .ll-cta').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  assert.equal(await page.locator('#ll-assistant .ll-modeline').innerText(), 'AI suggestions can be wrong.');
  assert.ok((await eventNames(page)).includes('ll_download_finished'));

  let r = await ask(page, 'Age 7, phonics, 45 min');
  assert.equal(r.turn.source, 'ai');
  assert.ok(r.turn.ids.every((id) => cat.byId[id]), 'fake id and URL discarded');
  assert.ok(!r.text.includes('evil.example'));

  r = await ask(page, 'Age 7, phonics, 45 min qqone');
  assert.equal(r.turn.source, 'ai');
  assert.equal(r.turn.ids[0], 'phonics_LadderPhonics', 'free game put first after the model left it out (A8)');
  assert.ok(r.turn.items.length >= 2 && r.turn.items.length <= 3, '45 min gives 2 to 3 games (A7)');

  for (const text of ['DSE writing qqkid', 'adult business english qqkid']) {
    r = await ask(page, text);
    assert.equal(r.turn.source, 'ai');
    assert.ok(!cat.byId[r.turn.ids[0]].kid, `${text}: kid-themed game first`);
    assert.ok(!['finance_MiniBusinessTycoonJunior', 'finance_MiniBusinessTycoonSuper'].includes(r.turn.ids[0]));
  }

  r = await ask(page, 'Age 7 phonics qqbad');
  assert.equal(r.turn.source, 'rules');
  assert.ok(!r.text.includes('evil.example'));

  r = await ask(page, 'phonics qqask');
  assert.equal(r.turn.askType, 'age');
  assert.match(r.text, /^How old are they\?/);
  assert.ok(!r.text.includes('evil') && !r.text.includes('Adults'), "the model's own question text is never shown");
  await r.el.locator('.ll-chip', { hasText: 'Age 8–9' }).click();
  await page.waitForFunction(() => { const t = LLAssistant.internals.turns(); return t[t.length - 1].who === 'bot' && t[t.length - 1].kind === 'picks'; });

  r = await ask(page, 'Age 7 phonics qqcrash');
  assert.equal(r.turn.source, 'rules', 'crash answered by keyword matching');
  assert.ok(r.turn.ids.length > 0);
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'failed');
  assert.equal(await page.locator('#ll-assistant .ll-modeline').innerText(), 'Matches by keyword.');
  r = await ask(page, 'Age 9, grammar, tenses');
  assert.equal(r.turn.source, 'rules');
  assert.deepEqual(errors, [], 'worker errors stay out of the page error log');
  await context.close();
});

test('Second visit: a fully cached model starts without a download click or download event', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant);
  const model = cat.model;
  await page.evaluate(async (m) => {
    const put = async (name, url, body) => (await caches.open(name)).put(url, new Response(body));
    await put('webllm/model', m.url + 'tensor-cache.json', JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 1 }] }));
    await put('webllm/model', m.url + 'params_shard_0.bin', 'x');
    await put('webllm/model', m.url + 'tokenizer.json', '{}');
    await put('webllm/config', m.url + 'mlc-chat-config.json', '{}');
    await put('webllm/wasm', m.lib, 'x');
  }, model);
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  assert.ok(!(await eventNames(page)).includes('ll_download_started'));
  assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false);
  await context.close();
});

// ---------- fixes from the review round ----------

const PAUSE = (b) => b.replace('defer data-avoid="#email-gate"', 'defer data-avoid="#email-gate" data-clarity="pause"');
// Stand-in for a session recorder: page-level capture listeners, as Clarity binds them.
const RECORDER = `window.__seen = {};
  ['click','mousedown','mousemove','pointerdown','wheel','scroll','input','change','keydown','focus'].forEach(function (t) {
    document.addEventListener(t, function (e) { var r = document.getElementById('ll-assistant'); if (r && e.target && e.target.nodeType && r.contains(e.target)) window.__seen[t] = (window.__seen[t] || 0) + 1; }, true);
  });`;

test('Pause mode: no widget event reaches page-level listeners; mask mode still lets clicks through (7B)', async () => {
  for (const mode of ['pause', 'mask']) {
    const { context, page } = await newPage(mode === 'pause' ? { demoPatch: PAUSE } : {});
    await context.addInitScript(RECORDER);
    await openWidget(page);
    await page.locator('#ll-assistant .ll-input').click();
    await page.keyboard.type('Primary 5 student vocabulary');
    await page.locator('#ll-assistant .ll-send').click();
    await page.waitForFunction(() => document.querySelectorAll('#ll-assistant .ll-card').length > 0);
    await page.locator('#ll-assistant .ll-card .ll-chip').first().click();
    await page.mouse.move(1000, 600);
    await page.mouse.wheel(0, 200);
    const seen = await page.evaluate(() => window.__seen);
    if (mode === 'pause') assert.deepEqual(seen, {}, 'pause mode: widget events seen by the page: ' + JSON.stringify(seen));
    else { assert.ok(seen.click > 0, 'mask mode keeps clicks visible'); assert.ok(!seen.input && !seen.change && !seen.keydown, 'typing never visible'); }
    assert.equal((await page.evaluate(() => window.__opened)).length, 1, `${mode}: the level button still opened its game`);
    await context.close();
  }
});

test('Pause mode: an answer that arrives after close is not drawn until reopen; send button resets', async () => {
  const { context, page } = await newPage({ demoPatch: PAUSE });
  await context.route('**/catalogue.compact.json', async (r) => { await new Promise((res) => setTimeout(res, 1500)); r.continue(); });
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.locator('#ll-assistant .ll-input').fill('Primary 5 student vocabulary');
  await page.locator('#ll-assistant .ll-input').press('Enter');
  await page.locator('#ll-assistant .ll-input').fill('an unsent draft');
  await page.locator('#ll-assistant .ll-close').click();
  assert.equal(await page.locator('#ll-assistant .ll-send').isDisabled(), true, 'no sign of the draft after close');
  await page.waitForFunction(() => LLAssistant.internals.turns().length === 2, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#ll-assistant .ll-msg').count(), 0, 'nothing drawn while closed');
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => document.querySelectorAll('#ll-assistant .ll-card').length > 0);
  await context.close();
});

test('A failed catalogue load survives a language switch and the queued question is answered after retry', async () => {
  const { context, page } = await newPage();
  let fail = true;
  await context.route('**/catalogue.compact.json', (r) => (fail ? r.fulfill({ status: 503, body: '' }) : r.continue()));
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForSelector('text=The game list did not load.');
  await page.locator('#ll-assistant .ll-input').fill('中四學生 口語');
  await page.locator('#ll-assistant .ll-input').press('Enter');
  await page.waitForSelector('text=遊戲清單載入唔到。');
  assert.equal(await page.locator('#ll-assistant .ll-chip', { hasText: '再試' }).count(), 1);
  fail = false;
  await page.locator('#ll-assistant .ll-chip', { hasText: '再試' }).click();
  await page.waitForFunction(() => LLAssistant.internals.turns().some((t) => t.kind === 'picks'));
  await context.close();
});

test('A natural reply to "How old are they?" is understood', async () => {
  const { context, page } = await newPage();
  await openWidget(page);
  let r = await ask(page, 'reading practice');
  assert.equal(r.turn.askType, 'age');
  r = await ask(page, "she's 9");
  assert.equal(r.turn.askType, 'reading', 'age taken from the reply');
  assert.match(r.text, /There is no reading game yet/);
  await context.close();
});

test('CTA buttons use the site padding exactly (9A)', async () => {
  const { context, page } = await newPage({ fakeGpu: true });
  await openWidget(page);
  for (const sel of ['.ll-send', '.ll-offer .ll-cta']) {
    assert.equal(await page.locator('#ll-assistant ' + sel).evaluate((b) => getComputedStyle(b).padding), '11px 26px', sel);
  }
  await page.locator('#ll-assistant .ll-close').click();
  assert.equal(await page.locator('#ll-assistant .ll-launcher').evaluate((b) => getComputedStyle(b).padding), '11px 26px', 'launcher');
  await context.close();
});
