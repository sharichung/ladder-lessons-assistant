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
const { checkQuestion, runQuestion } = require(path.join(ROOT, 'tests', 'check.js'));
const CLARITY_JS = require.resolve('clarity-js/build/clarity.min.js');
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8')));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const GAME = Object.fromEntries(source.games.map((g) => [g.id, g]));
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
  assert.equal(await page.locator('#ll-assistant .ll-privacy svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#ll-assistant .ll-foot').count(), 0, 'no AI note in keyword mode');
  assert.doesNotMatch(await page.locator('#ll-assistant .ll-panel').innerText(), /sorry|error|not supported|unavailable/i);

  let lang = 'en';
  for (const q of questions) {
    if (q.after || core.isFollowUp(q.text)) continue; // follow-ups: own test, each in a fresh conversation
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
      name: (c.querySelector('.ll-card-title').textContent || '').replace(/\s*↗\s*$/, ''),
      tier: c.querySelector('.ll-tier').textContent, bg: getComputedStyle(c.querySelector('.ll-tier')).backgroundColor,
      tags: c.querySelector('.ll-meta > span:not(.ll-tier)').textContent.split(' · '), how: !!c.querySelector('.ll-how'),
      pills: [...c.querySelectorAll('*')].filter((n) => { const b = getComputedStyle(n).backgroundColor; return b !== 'rgba(0, 0, 0, 0)' && b !== 'rgb(255, 255, 255)'; }).length,
      plan: !!c.querySelector('.ll-plan'),
      levels: [...c.querySelectorAll('.ll-chip')].map((b) => b.textContent.replace(/\s*↗\s*$/, '')),
    })));
    assert.equal(cards.length, turn.items.length);
    turn.items.forEach((it, i) => {
      const g = cat.byId[it.ids ? it.ids[0] : it.id];
      assert.equal(cards[i].name, it.ids ? 'Ladder Vocabulary' : g.title, q.id);
      assert.equal(cards[i].tier, TIER_LABEL[lang][g.tier], `${q.id}: plan label`);
      assert.equal(cards[i].bg, TIER_BG[g.tier], `${q.id}: plan colour`);
      assert.ok(cards[i].tags.includes(lang === 'zh' ? { led: '老師帶領', solo: '學生自己玩' }[g.mode] : { led: 'Teacher-led', solo: 'Student solo' }[g.mode]), `${q.id}: mode tag`);
      assert.equal(cards[i].how, false, 'no how-to-run line without a per-game value');
      assert.equal(cards[i].pills, 1, `${q.id}: the plan label is the only coloured element on the card (A8)`);
      assert.equal(cards[i].plan, g.tier !== 'free', `${q.id}: "opens the plan details" on paid cards only`);
      assert.equal(cards[i].tags[0], g.skill && (lang === 'zh' ? source.categories.find((c) => c.id === g.skill).zh : source.categories.find((c) => c.id === g.skill).en), `${q.id}: category first on the meta line`);
      if (it.kid) assert.ok(cards[i].tags.includes(lang === 'zh' ? '兒童主題' : 'Kid-themed'), `${q.id}: kid tag`);
      if (it.ids) assert.deepEqual(cards[i].levels, it.ids.map((id) => cat.byId[id].level_min), `${q.id}: one link per level`);
      if (!it.ids && cat.byId[it.id].level_min) assert.ok(cards[i].tags.some((t) => /A1|A2|B1|B2|C1|C2/.test(t)), `${q.id}: level tag`);
    });
    if (turn.kidNote) assert.equal(await el.locator('.ll-cards > li.ll-small').count(), 1);
  }

  // Game clicks have their own test ("Game clicks hand off ..."), with navigation.

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
  await page.evaluate(() => document.querySelectorAll('a.card').forEach((c) => c.remove())); // free games then open in a (stubbed) new tab
  const startUrl = page.url();
  for (const q of questions) {
    if (q.expect === 'nothing-sent') continue;
    const n0 = requests.length;
    await page.locator('#ll-assistant .ll-input').click();
    await page.keyboard.type(q.text, { delay: 0 });
    await page.locator('#ll-assistant .ll-send').click();
    await page.waitForFunction(() => LLAssistant.internals.turns().length % 2 === 0 && !document.querySelector('#ll-assistant .ll-thinking'));
    // Free games open in a new tab (stubbed). Paid games hand off or go to /library: own test.
    const free = lastBot(page).locator('.ll-card:has(.ll-tier[data-t="1"]) button.ll-card-title');
    if (await free.count()) await free.first().click();
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
    const title = lastBot(page).locator('.ll-card:has(.ll-tier[data-t="1"]) button.ll-card-title');
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
  const { context, page } = await newPage({ demoPatch: (b) => b.replace('defer data-avoid="#email-gate, #lock"', 'defer data-avoid="#email-gate, #lock" data-clarity="pause"') });
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
  assert.match(await lastBot(page).innerText(), /1\s*口說[\s\S]*2\s*寫作[\s\S]*6\s*聽力/);
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
  const btn = page.locator('#ll-assistant .ll-offer .ll-btn');
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
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => /Downloading AI · [1-9]\d?% · \d+ of \d+ MB/.test(document.querySelector('#ll-assistant .ll-progress-text')?.textContent || ''));
  assert.ok(await page.locator('#ll-assistant .ll-bar span').evaluate((s) => parseFloat(s.style.width)) > 0);
  await page.locator('#ll-assistant .ll-offer button', { hasText: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn').first().isVisible(), true);
  await context.close();
});

test('AI mode (fake model): free-first, lesson length, kid-themed order, fixed question, bad output, crash', async () => {
  const { context, page, errors } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await openWidget(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  assert.ok((await eventNames(page)).includes('ll_download_finished'));

  let r = await ask(page, 'Age 7, phonics, 45 min');
  assert.equal(r.turn.source, 'ai');
  assert.equal(await r.el.locator('.ll-foot').innerText(), 'AI suggestions can be wrong.', 'AI note under each model reply (C5)');
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
  assert.equal(await r.el.locator('.ll-foot').count(), 0, 'no AI note under a keyword reply');
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

const PAUSE = (b) => b.replace('defer data-avoid="#email-gate, #lock"', 'defer data-avoid="#email-gate, #lock" data-clarity="pause"');
// Stand-in for a session recorder: page-level capture listeners on document,
// as Clarity binds them. A window listener added before the widget counts what
// really happened, so every "not seen" below is checked against "it fired".
const RECORDER_TYPES = ['click', 'mousedown', 'mousemove', 'pointerdown', 'wheel', 'scroll', 'focus', 'input', 'change', 'keydown', 'keyup', 'keypress',
  'beforeinput', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'select', 'cut', 'copy', 'paste', 'touchcancel',
  'dragstart', 'drag', 'dragend', 'drop', 'selectionchange'];
const TYPING = ['input', 'change', 'keydown', 'keyup', 'keypress', 'beforeinput', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'select', 'cut', 'copy', 'paste'];
const RECORDER = `window.__seen = {}; window.__fired = {};
  function __inWidget(t, e) {
    var r = document.getElementById('ll-assistant'); if (!r) return false;
    if (e.target && e.target.nodeType && r.contains(e.target)) return true;
    var s = t === 'selectionchange' && document.getSelection();
    return !!(s && (r.contains(s.anchorNode) || r.contains(s.focusNode)));
  }
  ${JSON.stringify(RECORDER_TYPES)}.forEach(function (t) {
    window.addEventListener(t, function (e) { if (__inWidget(t, e)) window.__fired[t] = (window.__fired[t] || 0) + 1; }, true);
    document.addEventListener(t, function (e) { if (__inWidget(t, e)) window.__seen[t] = (window.__seen[t] || 0) + 1; }, true);
  });`;

// Everything a visitor can do inside the open widget: type, select, cut, copy,
// paste, a Chinese input-method word, send, drag-select an answer, touch, drag, click, scroll.
async function exerciseWidget(page, context) {
  const input = page.locator('#ll-assistant .ll-input');
  await input.click();
  await page.keyboard.type('Primary 5 student vocabulary');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+X');
  await page.keyboard.press('Control+V');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '生', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '生' });
  await input.fill('Primary 5 student vocabulary');
  await page.locator('#ll-assistant .ll-send').click();
  await page.waitForFunction(() => document.querySelectorAll('#ll-assistant .ll-card').length > 0);
  const box = await page.locator('#ll-assistant .ll-you').first().boundingBox();
  await page.mouse.move(box.x + 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await page.locator('#ll-assistant .ll-title').evaluate((n) => {
    ['touchcancel', 'dragstart', 'drag', 'dragend', 'drop'].forEach((t) => n.dispatchEvent(new Event(t, { bubbles: true })));
  });
  // A library card for the level, so the click is handed to the page (no navigation).
  await page.evaluate(() => {
    const a = document.createElement('a'); a.className = 'card'; a.setAttribute('data-title', 'Ladder Vocabulary · A1'); a.href = '#';
    a.addEventListener('click', (e) => { e.preventDefault(); window.__hostClicks.push(a.getAttribute('data-title')); });
    document.body.appendChild(a);
  });
  await page.locator('#ll-assistant .ll-card .ll-chip').first().click();
  await page.mouse.move(1000, 600);
  await page.mouse.wheel(0, 200);
}

test('Pause mode: no widget event reaches page-level listeners; mask mode still lets clicks through (7B)', async () => {
  for (const mode of ['pause', 'mask']) {
    const { context, page } = await newPage(mode === 'pause' ? { demoPatch: PAUSE } : {});
    await context.addInitScript(RECORDER);
    await openWidget(page);
    await exerciseWidget(page, context);
    const { seen, fired } = await page.evaluate(() => ({ seen: window.__seen, fired: window.__fired }));
    for (const t of ['click', 'mousedown', 'pointerdown', 'keydown', 'keyup', 'keypress', 'beforeinput', 'textInput', 'input', 'select', 'cut', 'copy', 'paste', 'compositionstart', 'compositionend', 'touchcancel', 'dragstart', 'drop']) {
      assert.ok(fired[t] > 0, `${mode}: the test really produced ${t}`);
    }
    if (mode === 'pause') {
      assert.ok(fired.selectionchange > 0, 'pause: the test really changed the selection');
      assert.deepEqual(seen, {}, 'pause mode: widget events seen by the page: ' + JSON.stringify(seen));
    } else {
      assert.ok(seen.click > 0, 'mask mode keeps clicks visible');
      const typed = TYPING.filter((t) => seen[t]);
      assert.deepEqual(typed, [], 'typing, selection and clipboard events never visible');
    }
    assert.deepEqual(await page.evaluate(() => window.__hostClicks), ['Ladder Vocabulary · A1'], `${mode}: the level button still opened its game`);
    if (mode === 'pause') {
      await page.locator('#ll-assistant .ll-close').click();
      assert.equal(await page.evaluate(() => { const s = document.getSelection(); const r = document.getElementById('ll-assistant'); return !!(s && r.contains(s.anchorNode)); }), false, 'no selection left inside the widget after close');
    }
    await context.close();
  }
});

test('Escape in a page field belongs to the page; Escape on the page or in the widget closes it', async () => {
  for (const mode of ['pause', 'mask']) {
    const { context, page } = await newPage(mode === 'pause' ? { demoPatch: PAUSE } : {});
    await openWidget(page);
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'hostinput'; document.body.prepend(i); });
    await page.locator('#ll-assistant .ll-input').fill('a draft question about phonics');
    await page.locator('#hostinput').click();
    await page.keyboard.type('host query');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => LLAssistant.internals.state().open), true, `${mode}: still open`);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'hostinput', `${mode}: focus stays in the page field`);
    assert.equal(await page.locator('#ll-assistant .ll-input').inputValue(), 'a draft question about phonics', `${mode}: draft kept`);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => LLAssistant.internals.state().open), false, `${mode}: Escape on the page closes`);
    await page.locator('#ll-assistant .ll-launcher').click();
    await page.locator('#ll-assistant .ll-input').press('Escape');
    assert.equal(await page.evaluate(() => LLAssistant.internals.state().open), false, `${mode}: Escape in the widget closes`);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ll-launcher')), true, `${mode}: focus back on the launcher`);
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

test('A natural reply to "How old are they?" is understood, in digits or words', async () => {
  for (const [question, reply] of [['reading practice', "she's 9"], ['reading practice', 'nine'], ['reading practice', 'she is nine'], ['閱讀練習', '九'], ['閱讀練習', '佢今年九']]) {
    const { context, page } = await newPage();
    await openWidget(page);
    let r = await ask(page, question);
    assert.equal(r.turn.askType, 'age', question);
    r = await ask(page, reply);
    assert.equal(r.turn.askType, 'reading', `age taken from "${reply}"`);
    assert.match(r.text, /There is no reading game yet|暫時未有閱讀遊戲/);
    await context.close();
  }
});

test('A typed age after picks shown without an age joins the earlier question', async () => {
  const { context, page } = await newPage();
  await openWidget(page);
  const idsOf = (items) => items.flatMap((it) => it.ids || [it.id]);
  for (const [question, reply, joined] of [
    ['phonics', '7', 'phonics. Age 7'],
    ['phonics', "she's 7", 'phonics. Age 7'],
    ['phonics', 'Age 7', 'phonics. Age 7'],
    ['speaking games', 'she is 12', 'speaking games. she is 12'],
    ['拼讀', '7歲', '拼讀. 7歲'],
  ]) {
    let r = await ask(page, question);
    assert.equal(r.turn.kind, 'picks', question);
    assert.equal(await r.el.locator('.ll-chips .ll-chip').count(), 5, 'age chips shown');
    r = await ask(page, reply);
    const want = core.recommendRules(cat, joined);
    assert.equal(r.turn.kind, 'picks', `"${reply}" after "${question}"`);
    assert.deepEqual(idsOf(r.turn.items), idsOf(want.items), `"${reply}" after "${question}" answers "${joined}"`);
  }
  // A new question is not an age answer.
  await ask(page, 'phonics');
  const r = await ask(page, 'grammar');
  assert.deepEqual(idsOf(r.turn.items), idsOf(core.recommendRules(cat, 'grammar').items));
  await context.close();
});

// ---------- look and behaviour (colour budget, cards, composer, grouping) ----------

const INK = 'rgb(44, 62, 80)';
const CORALS = ['rgb(255, 107, 107)', 'rgb(255, 142, 83)', 'rgb(201, 69, 63)', 'rgb(231, 76, 60)'];

// Every element in the widget: its border colours, and whether it carries coral or the gradient.
async function colourSnapshot(page) {
  return page.evaluate((corals) => {
    const out = [];
    for (const n of document.querySelectorAll('#ll-assistant, #ll-assistant *')) {
      const cs = getComputedStyle(n);
      const borders = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.outlineColor];
      const paint = [cs.color, cs.backgroundColor, cs.backgroundImage, cs.boxShadow, cs.textDecorationColor].join(' ');
      const coral = corals.some((c) => paint.includes(c)) || /gradient/.test(cs.backgroundImage);
      const primary = n.classList.contains('ll-send') && !n.disabled;
      out.push({ cls: n.className && n.className.baseVal == null ? n.className : '', tag: n.tagName, borders, coralBorder: borders.some((b) => corals.includes(b)), coral, primary });
    }
    return out;
  }, CORALS);
}

function assertColours(snap, state) {
  for (const n of snap) {
    assert.ok(!n.coralBorder, `${state}: coral or red border on ${n.tag}.${n.cls} (E1)`);
    if (n.coral) assert.ok(n.primary, `${state}: coral or gradient on ${n.tag}.${n.cls}, which is not the enabled primary button (E2)`);
  }
}

test('Colour budget in every state: coral only on the enabled primary button, ink borders, ink cards (E1-E3, A1-A8)', async () => {
  const { context, page } = await newPage({ fakeGpu: true });
  await openWidget(page);
  assertColours(await colourSnapshot(page), 'empty, send disabled');
  assert.equal(await page.locator('#ll-assistant .ll-send').evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b).color, getComputedStyle(b).borderTopColor, getComputedStyle(b).boxShadow].join('|')), 'rgb(229, 231, 235)|rgb(90, 108, 125)|rgb(156, 163, 175)|none', 'B5 disabled button');
  await ask(page, 'adult business english');
  await ask(page, 'Primary 5 student vocabulary');
  await page.locator('#ll-assistant .ll-input').fill('typing');
  const states = [];
  states.push(['rest', await colourSnapshot(page)]);
  // hover and press every control, then keyboard focus through all of them
  const controls = page.locator('#ll-assistant button:visible, #ll-assistant .ll-card');
  const n = await controls.count();
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    const box = await c.boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x + 4, box.y + 4);
    states.push([`hover ${i}`, await colourSnapshot(page)]);
  }
  const send = await page.locator('#ll-assistant .ll-send').boundingBox();
  await page.mouse.move(send.x + 5, send.y + 5);
  await page.mouse.down();
  states.push(['active send', await colourSnapshot(page)]);
  await page.mouse.up();
  await page.locator('#ll-assistant .ll-input').fill('typing');
  await page.locator('#ll-assistant .ll-input').focus();
  for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); states.push([`focus ${i}`, await colourSnapshot(page)]); }
  for (const [state, snap] of states) assertColours(snap, state);
  assert.ok(states[0][1].some((x) => x.primary && x.coral), 'the enabled primary button has the gradient');

  // E3, A1: every card has the 3px ink border, rounded, white
  const cards = await page.locator('#ll-assistant .ll-card').evaluateAll((cs) => cs.map((c) => { const s = getComputedStyle(c); return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.backgroundColor, s.borderTopLeftRadius].join(' '); }));
  assert.ok(cards.length >= 4);
  for (const c of cards) assert.equal(c, `3px solid ${INK} rgb(255, 255, 255) 16px`);
  // A6: chips are white pills with a 2.5px ink outline, Fredoka 600
  const chip = await page.locator('#ll-assistant .ll-chip').first().evaluate((c) => { const s = getComputedStyle(c); return [s.borderTopWidth, s.borderTopColor, s.backgroundColor, s.fontWeight, s.fontFamily.split(',')[0]].join('|'); });
  const w25 = await page.evaluate(() => Math.floor(2.5 * devicePixelRatio) / devicePixelRatio + 'px'); // 2.5px, snapped to device pixels
  assert.equal(chip, `${w25}|${INK}|rgb(255, 255, 255)|600|Fredoka`);
  // A3: the teacher's bubble is teal-pale with ink text
  assert.equal(await page.locator('#ll-assistant .ll-you').first().evaluate((b) => getComputedStyle(b).backgroundColor + '|' + getComputedStyle(b).color), `rgba(78, 205, 196, 0.14)|${INK}`);
  await context.close();
});

test('Composer, header and conversation layout (B1-B5, C1-C10)', async () => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }]) {
    const { context, page } = await newPage({ viewport });
    await openWidget(page);
    const tag = `${viewport.width}px`;
    // C4: the text box has focus (the widget focuses it 30 ms after opening), B3: the ring is on the composer box
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('ll-input'), null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ll-input')), true, `${tag}: text box focused on open`);
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector('#ll-assistant ' + s), cs = (s) => getComputedStyle(q(s));
      const input = q('.ll-input'), ctx = document.createElement('canvas').getContext('2d');
      ctx.font = cs('.ll-input').fontSize + ' ' + cs('.ll-input').fontFamily;
      return {
        composer: [cs('.ll-composer').borderTopWidth, cs('.ll-composer').borderTopColor, cs('.ll-composer').backgroundColor, cs('.ll-composer').borderTopLeftRadius, cs('.ll-composer').boxShadow].join('|'),
        inputBorder: cs('.ll-input').borderTopStyle + '|' + cs('.ll-input').borderTopColor, inputShadow: cs('.ll-input').boxShadow,
        rows: input.getAttribute('rows'), label: input.labels && input.labels[0] && input.labels[0].textContent, labelledby: input.getAttribute('aria-labelledby'),
        placeholderFits: ctx.measureText(input.placeholder).width <= input.clientWidth,
        inside: (() => { const c = q('.ll-composer').getBoundingClientRect(), b = q('.ll-send').getBoundingClientRect(), i = input.getBoundingClientRect(); return b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom && i.left >= c.left && i.right <= b.left; })(),
        centred: (() => { const b = q('.ll-send').getBoundingClientRect(), i = input.getBoundingClientRect(); return Math.abs((b.top + b.bottom) / 2 - (i.top + i.bottom) / 2) <= 2; })(),
        sendH: q('.ll-send').getBoundingClientRect().height, oneLine: input.getBoundingClientRect().height,
        title: [cs('.ll-title').whiteSpace, q('.ll-title').getBoundingClientRect().height],
        lock: [cs('.ll-privacy').fontSize, cs('.ll-privacy').fontWeight, getComputedStyle(q('.ll-privacy span')).textWrap || getComputedStyle(q('.ll-privacy span')).textWrapStyle, cs('.ll-privacy').borderBottomWidth + ' ' + cs('.ll-privacy').borderBottomColor].join('|'),
        scrollbar: cs('.ll-log').scrollbarWidth + '|' + cs('.ll-log').scrollbarColor,
        intro: !!q('.ll-intro'),
      };
    });
    const w25 = await page.evaluate(() => Math.floor(2.5 * devicePixelRatio) / devicePixelRatio + 'px'); // 2.5px, snapped to device pixels
    assert.equal(m.composer, `${w25}|${INK}|rgb(255, 255, 255)|16px|rgb(255, 230, 109) 0px 0px 0px 4px`, `${tag}: composer box with the yellow focus ring (B1, B3, A5)`);
    assert.equal(m.inputBorder.split('|')[0], 'none', `${tag}: the text box has no border of its own`);
    assert.equal(m.inputBorder.split('|')[1], INK, `${tag}: input border colour is ink`);
    assert.equal(m.inputShadow, 'none');
    assert.equal(m.rows, '1');
    assert.equal(m.label, 'Describe your student', 'C8: own label');
    assert.equal(m.labelledby, null);
    assert.ok(m.placeholderFits, `${tag}: placeholder fits on one line (B4)`);
    assert.ok(m.inside, `${tag}: button inside the composer box, at the right (B2)`);
    assert.ok(m.centred, `${tag}: button centred on a one-line text box (B2)`);
    assert.ok(m.sendH >= 44, 'button at least 44px');
    assert.equal(m.title[0], 'nowrap', 'C5: title on one line');
    assert.equal(m.lock, `13px|400|balance|1px ${'rgb(229, 231, 235)'}`, `${tag}: lock line 13px normal weight, balanced; header line`);
    assert.equal(m.scrollbar, 'thin|rgb(229, 231, 235) rgba(0, 0, 0, 0)', 'C6');
    assert.ok(m.intro, 'intro in the empty state');
    assert.equal(await page.getByRole('textbox', { name: 'Describe your student' }).count(), 1);
    // B4: grows to four lines, then scrolls
    const input = page.locator('#ll-assistant .ll-input');
    await input.fill('one\ntwo\nthree');
    const h3 = await input.evaluate((i) => i.getBoundingClientRect().height);
    await input.fill('one\ntwo\nthree\nfour\nfive\nsix');
    const h6 = await input.evaluate((i) => i.getBoundingClientRect().height);
    assert.ok(h3 > m.oneLine * 1.8, `${tag}: grows (${m.oneLine} -> ${h3})`);
    assert.ok(h6 < m.oneLine * 3.2 && h6 > h3, `${tag}: stops at four lines (${h6})`);
    const bottoms = await page.evaluate(() => { const b = document.querySelector('#ll-assistant .ll-send').getBoundingClientRect(), i = document.querySelector('#ll-assistant .ll-input').getBoundingClientRect(); return Math.abs(b.bottom - i.bottom); });
    assert.ok(bottoms <= 2, 'button bottom-aligned when the text box grows (sub-pixel rounding allowed)');
    await input.fill('');

    // C3/C10: the intro goes once a message is sent; C1/C2: turns
    await ask(page, 'Year 5 speaking');
    assert.equal(await page.locator('#ll-assistant .ll-intro').count(), 0, 'intro removed after the first message');
    await ask(page, 'any other recommendations');
    const g = await page.evaluate(() => {
      const turns = [...document.querySelectorAll('#ll-assistant .ll-log > .ll-turn')];
      const cs = (n) => getComputedStyle(n);
      const you = document.querySelector('#ll-assistant .ll-you'), log = document.querySelector('#ll-assistant .ll-log').getBoundingClientRect();
      const cards = [...turns[0].querySelectorAll('.ll-card')].map((c) => c.getBoundingClientRect());
      return {
        turns: turns.length, kids: turns.map((t) => [...t.children].map((c) => c.classList.contains('ll-you') ? 'you' : 'bot').join(',')),
        gap: cs(turns[0]).rowGap, between: cs(turns[1]).borderTopWidth + ' ' + cs(turns[1]).borderTopColor + ' ' + (parseFloat(cs(turns[1]).marginTop) + parseFloat(cs(turns[1]).paddingTop)),
        youRight: Math.abs(you.getBoundingClientRect().right - (log.right - parseFloat(cs(document.querySelector('#ll-assistant .ll-log')).paddingRight))) < 2,
        cardGap: cards.length > 1 ? Math.round(cards[1].top - cards[0].bottom) : null,
      };
    });
    assert.equal(g.turns, 2);
    assert.deepEqual(g.kids, ['you,bot', 'you,bot'], 'one teacher message and its reply per group');
    assert.equal(g.gap, '8px');
    assert.equal(g.between, '1px rgb(229, 231, 235) 24', '24px and a line between turns');
    assert.ok(g.youRight, 'teacher message on the right');
    assert.equal(g.cardGap, 8, 'cards 8px apart');
    await context.close();
  }
});

test('First result card is fully visible without scrolling at 375px (rule 9)', async () => {
  const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
  await openWidget(page);
  for (const text of ['Year 5 speaking', 'Adult learner, B2, IELTS speaking part 2 practice, 60 minutes', '小五學生 生字']) {
    const { el } = await ask(page, text);
    const ok = await el.evaluate((bot) => {
      const card = bot.querySelector('.ll-card').getBoundingClientRect(), log = bot.closest('.ll-log').getBoundingClientRect();
      return card.top >= log.top && card.bottom <= log.bottom && card.bottom <= innerHeight;
    });
    assert.ok(ok, `${text}: first card cut off`);
  }
  await context.close();
});

test('Whole card opens the game; "more" only expands; one control and one event per card (A9, C7)', async () => {
  const { context, page } = await newPage();
  await openWidget(page);
  await page.evaluate(() => document.querySelectorAll('a.card').forEach((c) => c.remove())); // no host cards: a free game opens in a new tab
  const { el } = await ask(page, 'Year 5 speaking');
  const first = el.locator('.ll-card').first();
  assert.equal(await first.locator('.ll-card-title').innerText().then((t) => t.replace(/\s*↗\s*$/, '')), 'Quick Fire Flashcards');
  // one focusable control per card besides "more", named by the title only
  const focusables = await el.locator('.ll-card').evaluateAll((cs) => cs.map((c) => [...c.querySelectorAll('button, a[href], [tabindex]')].filter((b) => !b.classList.contains('ll-more')).length));
  assert.deepEqual([...new Set(focusables)], [1]);
  assert.equal(await page.getByRole('button', { name: 'Quick Fire Flashcards', exact: true }).count(), 1);
  // click the description area
  const before = (await eventNames(page)).filter((e) => e === 'll_game_click').length;
  const d = await first.locator('.ll-desc').boundingBox();
  await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2);
  const origin = new URL(DEMO).origin;
  assert.deepEqual(await page.evaluate(() => window.__opened), [origin + GAME_PATH_QFF]);
  assert.equal((await eventNames(page)).filter((e) => e === 'll_game_click').length, before + 1, 'exactly one ll_game_click');
  // "more" expands and does not open the game
  const withMore = el.locator('.ll-card:has(.ll-more)').first();
  assert.ok(await withMore.count(), 'a long description has "more"');
  const h0 = await withMore.locator('.ll-desc').evaluate((x) => x.clientHeight);
  await withMore.locator('.ll-more').click();
  assert.ok(await withMore.locator('.ll-desc').evaluate((x) => x.clientHeight) > h0, 'expanded');
  assert.equal(await withMore.locator('.ll-more').innerText(), 'less');
  assert.equal((await page.evaluate(() => window.__opened)).length, 1, '"more" did not open a game');
  assert.equal((await eventNames(page)).filter((e) => e === 'll_game_click').length, before + 1);
  assert.ok(await el.locator('.ll-desc').evaluateAll((ds) => ds.every((x) => getComputedStyle(x).textOverflow !== 'ellipsis' && getComputedStyle(x).webkitLineClamp === 'none')), 'no ellipsis');
  // keyboard focus on the title draws the ring on the card
  await first.locator('.ll-card-title').focus();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await page.waitForTimeout(300); // let the lift transition finish
  const ring = await page.evaluate(() => { const c = document.activeElement.closest('.ll-card'); return c && getComputedStyle(c).boxShadow + '|' + getComputedStyle(document.activeElement).boxShadow; });
  assert.match(ring, /rgb\(255, 230, 109\) 0px 0px 0px 4px\|none$/, 'ring on the card, not on the title');
  await context.close();
});
const GAME_PATH_QFF = '/speaking/open-ended/speaking_QuickFireFlashcards';

// Serve the repo as if it were https://app.ladderlessons.com, so location.origin is the members site.
async function serveAs(context, origin) {
  await context.route(origin + '/**', (r) => {
    const u = new URL(r.request().url());
    const file = path.join(ROOT, decodeURIComponent(u.pathname));
    if (u.pathname !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
      return r.fulfill({ contentType: type, body: fs.readFileSync(file) });
    }
    return r.fulfill({ contentType: 'text/html', body: '<p>page ' + u.pathname + '</p>' });
  });
}

test('Game clicks hand off to the host page: paid games never navigate by themselves (both sites)', async () => {
  const paidPaths = source.games.filter((g) => !g.in_public_build).map((g) => g.path.split('?')[0]);
  for (const origin of [new URL(DEMO).origin, 'https://app.ladderlessons.com']) {
    const url = origin + '/demo.html';
    const setup = async ({ keepCards }) => {
      const env = await newPage();
      const navs = [];
      env.page.on('framenavigated', (f) => { if (f === env.page.mainFrame()) navs.push(f.url()); });
      if (!origin.startsWith('http://127')) await serveAs(env.context, origin);
      // Count analytics calls across navigations (same tab, same site).
      await env.context.addInitScript(() => {
        let fn;
        Object.defineProperty(window, 'gtag', { configurable: true, get: () => fn, set: (v) => { fn = function () { if (arguments[1] === 'll_game_click') sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks') || 0) + 1)); return v.apply(this, arguments); }; } });
      });
      await openWidget(env.page, url);
      if (!keepCards) await env.page.evaluate(() => document.querySelectorAll('a.card').forEach((c) => c.remove()));
      return { ...env, navs };
    };
    const clickCard = async (page, query, title) => {
      const { el } = await ask(page, query);
      const card = el.locator('.ll-card', { has: page.locator('.ll-card-title', { hasText: title }) }).first();
      const d = await card.locator('.ll-desc').boundingBox();
      await page.mouse.click(d.x + 10, d.y + d.height / 2);
    };
    const clicks = (page) => page.evaluate(() => Number(sessionStorage.getItem('clicks') || 0));

    // 1. Paid game, host card on the page: the page's own click handler runs (lock pop-up), no navigation.
    let e = await setup({ keepCards: true });
    await clickCard(e.page, 'adult business english', 'Ladder Talk');
    await e.page.waitForFunction(() => !document.getElementById('lock').hidden);
    assert.deepEqual(await e.page.evaluate(() => window.__hostClicks), ['Ladder Talk'], `${origin}: host card clicked`);
    assert.equal(e.page.url(), url, `${origin}: no navigation`);
    assert.deepEqual(await e.page.evaluate(() => window.__opened), []);
    assert.equal(await clicks(e.page), 1, 'one ll_game_click');
    await e.page.waitForFunction(() => document.getElementById('ll-assistant').hidden, null, { timeout: 2000 }); // data-avoid: the widget steps aside for the pop-up
    await e.context.close();

    // 2. Free game, host card on the page: the page's card opens it at origin + path.
    e = await setup({ keepCards: true });
    await clickCard(e.page, 'telling the time for kids', 'Telling the Time');
    await e.page.waitForURL(origin + '/life/life_TellingTheTime');
    assert.equal(await clicks(e.page), 1);
    await e.context.close();

    // 3. No host card: paid goes to origin + /library; free opens origin + path.
    e = await setup({ keepCards: false });
    await clickCard(e.page, 'adult business english', 'Ladder Talk');
    await e.page.waitForURL(origin + '/library');
    assert.equal(await clicks(e.page), 1);
    const all = [...e.navs];
    await e.context.close();
    e = await setup({ keepCards: false });
    await clickCard(e.page, 'telling the time for kids', 'Telling the Time');
    assert.deepEqual(await e.page.evaluate(() => window.__opened), [origin + '/life/life_TellingTheTime']);
    assert.equal(e.page.url(), url);
    all.push(...e.navs, ...(await e.page.evaluate(() => window.__opened)));
    for (const r of e.requests) all.push(r.url);
    await e.context.close();

    // Never an absolute ladderlessons.com address for a paid game.
    const bad = all.filter((u) => /^https:\/\/(www\.)?ladderlessons\.com\//.test(u) && paidPaths.some((pp) => u.includes(pp)));
    assert.deepEqual(bad, [], `${origin}: paid game linked on ladderlessons.com`);
  }
});

test('Follow-ups keep the question and show new games; never "could not match" (D1)', async () => {
  for (const [first, follow, lang] of [['Year 5 speaking', 'any other recommendations', 'en'], ['Year 5 口說', '還有其他推薦嗎', 'zh'], ['Age 8, phonics', 'something else', 'en'], ['8歲 拼讀', '仲有冇', 'zh']]) {
    const { context, page } = await newPage();
    await openWidget(page);
    const a = await ask(page, first);
    const b = await ask(page, follow);
    assert.equal(b.turn.kind, 'picks', `${follow}: ${b.text}`);
    assert.ok(b.turn.ids.every((id) => !a.turn.ids.includes(id)), `${follow}: a game shown again`);
    const c = await ask(page, follow);
    assert.notEqual(c.turn.kind, 'none', `${follow} again`);
    assert.ok(c.turn.ids.every((id) => !a.turn.ids.includes(id) && !b.turn.ids.includes(id)));
    await context.close();
  }
  // Nothing left: say so and offer the skills.
  const { context, page } = await newPage();
  await openWidget(page);
  await ask(page, '6歲 口語');
  const r = await ask(page, '悶');
  assert.equal(r.turn.kind, 'ask');
  assert.match(r.text, /冇其他合適嘅遊戲喇/);
  assert.ok(await r.el.locator('.ll-chip .ll-num').count() >= 2, 'numbered skill choices');
  const r2 = await ask(page, 'something else');
  assert.doesNotMatch(r2.text, /could not match|配對唔到/);
  await context.close();
  // The fixed follow-up questions, each in its own conversation.
  for (const q of questions.filter((x) => x.after || core.isFollowUp(x.text))) {
    const env = await newPage();
    await openWidget(env.page);
    const prev = q.after ? await ask(env.page, q.after) : { turn: { kind: 'none', ids: [] } };
    const now = await ask(env.page, q.text);
    const c2 = checkQuestion({ ...q, parseAge: undefined }, now.turn, cat, prev.turn.kind === 'picks' ? prev.turn.ids : []);
    assert.ok(c2.ok, `${q.id}: ${c2.fails.join('; ')}`);
    await env.context.close();
  }
});

test('Screenshots at 320, 375 and 1280px with the site fonts (E5)', async () => {
  const dir = path.join(ROOT, 'tests', 'results', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  for (const width of [320, 375, 1280]) {
    const { context, page } = await newPage({ viewport: { width, height: width < 500 ? 667 : 800 } });
    // The site's Google Fonts, fetched by the test runner (TLS checked there) when online.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => { try { await r.fulfill({ response: await r.fetch() }); } catch (e) { await r.abort(); } });
    await openWidget(page, DEMO + '?site=1');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(dir, `${width}-1-empty.png`) });
    await ask(page, 'Year 5 speaking');
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.locator('#ll-assistant .ll-turn:last-child .ll-card').count() >= 3);
    await page.screenshot({ path: path.join(dir, `${width}-2-reply.png`) });
    await ask(page, 'any other recommendations');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(dir, `${width}-3-follow-up.png`) });
    await page.locator('#ll-assistant .ll-input').fill('Adult, B2, IELTS speaking, 60 min');
    await page.locator('#ll-assistant .ll-input').focus();
    await page.screenshot({ path: path.join(dir, `${width}-4-input-focused.png`) });
    for (const f of ['1-empty', '2-reply', '3-follow-up', '4-input-focused']) assert.ok(fs.statSync(path.join(dir, `${width}-${f}.png`)).size > 5000);
    await context.close();
  }
});


// ---------- fixes from the fourth review round ----------

test('Follow-up edge cases: after "no more", after an ask, nothing left at all (review 4)', async () => {
  // A skill picked after "No more games fit that" shows that skill's games, none repeated.
  let { context, page } = await newPage();
  await openWidget(page);
  const first = await ask(page, 'Age 7 phonics');
  await ask(page, 'more');
  let r = await ask(page, 'more');
  assert.equal(r.turn.noMore, true, 'phonics used up');
  const shown = (await page.evaluate(() => LLAssistant.internals.turns())).flatMap((t) => t.ids || []);
  const n0 = await page.evaluate(() => LLAssistant.internals.turns().length);
  await r.el.locator('.ll-chip').first().click();
  await page.waitForFunction((n) => LLAssistant.internals.turns().length === n, n0 + 2);
  const picked = (await page.evaluate(() => LLAssistant.internals.turns())).pop();
  assert.equal(picked.kind, 'picks');
  assert.ok(picked.ids.every((id) => !shown.includes(id)), 'no game shown twice: ' + picked.ids.join());
  assert.ok(picked.ids.every((id) => cat.byId[id].skill === 'speaking'), 'the picked skill: ' + picked.ids.join());
  assert.ok(first.turn.ids.length > 0);
  await context.close();

  // A follow-up after "no game for this age" keeps that question.
  ({ context, page } = await newPage());
  await openWidget(page);
  await ask(page, 'Age 9 grammar');
  await ask(page, 'Age 4 writing');
  r = await ask(page, 'something else');
  assert.equal(r.turn.kind, 'ask', 'not the age-9 grammar games again');
  assert.equal(r.turn.noMore, true);
  // A follow-up after "Which skill?" asks it again.
  await ask(page, 'Age 7 phonics');
  await ask(page, 'Adult');
  r = await ask(page, 'any other recommendations');
  assert.equal(r.turn.askType, 'skill');
  assert.ok(!r.turn.noMore && r.turn.ids.length === 0, 'no phonics game for age 7 after "Adult"');
  await context.close();

  // Nothing left and no other skill for this age: no promise of a choice.
  ({ context, page } = await newPage());
  await openWidget(page);
  await ask(page, 'Age 4 phonics');
  await ask(page, 'more');
  r = await ask(page, 'more');
  assert.match(r.text, /^No more games fit that yet\.$/);
  assert.equal(await r.el.locator('.ll-chip').count(), 0);
  await context.close();
});

test('Look edge cases: ring while hovered, Chinese titles, every card lifts, offer shrinks, re-measure on resize (review 4)', async () => {
  // Keyboard focus ring stays while the pointer is over the control.
  let { context, page } = await newPage({ viewport: { width: 1280, height: 800 } });
  await openWidget(page);
  const sendBox = await page.locator('#ll-assistant .ll-send').boundingBox();
  await page.mouse.move(sendBox.x + 10, sendBox.y + 10);
  await page.locator('#ll-assistant .ll-input').fill('Form 4 student');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  assert.match(await page.locator('#ll-assistant .ll-send').evaluate((b) => getComputedStyle(b).boxShadow), /rgb\(255, 230, 109\) 0px 0px 0px 4px/, 'Find games: ring while hovered');
  const r = await ask(page, 'Form 4 student');
  const chip = r.el.locator('.ll-chip').first();
  const cb = await chip.boundingBox();
  await page.mouse.move(cb.x + 5, cb.y + 5);
  await chip.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(200);
  assert.match(await chip.evaluate((b) => getComputedStyle(b).boxShadow), /rgb\(255, 230, 109\) 0px 0px 0px 4px/, 'chip: ring while hovered');
  // Card titles stay Fredoka 600 in Chinese; the Ladder Vocabulary card lifts too.
  const zh = await ask(page, '小五學生 生字');
  assert.deepEqual([...new Set(await zh.el.locator('.ll-card-title').evaluateAll((ts) => ts.map((t) => getComputedStyle(t).fontWeight + ' ' + getComputedStyle(t).letterSpacing)))], ['600 normal']);
  const family = zh.el.locator('.ll-card:has(p.ll-card-title)');
  const fb = await family.boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + 10);
  await page.waitForTimeout(250);
  assert.notEqual(await family.evaluate((c) => getComputedStyle(c).transform), 'none', 'the Ladder Vocabulary card lifts');
  await context.close();

  // The AI offer shrinks to one line after the first message, so the first card stays in view.
  ({ context, page } = await newPage({ fakeGpu: true, viewport: { width: 375, height: 667 } }));
  await openWidget(page);
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  const a = await ask(page, 'Year 5 speaking');
  assert.equal(await page.locator('#ll-assistant .ll-offer').evaluate((o) => o.classList.contains('ll-offer-min')), true);
  assert.ok(await a.el.evaluate((bot) => { const c = bot.querySelector('.ll-card').getBoundingClientRect(), l = bot.closest('.ll-log').getBoundingClientRect(); return c.top >= l.top && c.bottom <= l.bottom; }), 'first card fully visible with the offer');
  await page.locator('#ll-assistant .ll-offer .ll-link').click();
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn').count(), 1, 'the full offer comes back on request');
  await context.close();

  // After a rotation, every description longer than three lines has "more".
  ({ context, page } = await newPage({ viewport: { width: 667, height: 375 } }));
  await openWidget(page);
  for (const q of ['7 year old phonics', 'Year 5 speaking', 'IELTS speaking adult']) await ask(page, q);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(300);
  const cut = await page.evaluate(() => [...document.querySelectorAll('#ll-assistant .ll-desc:not(.ll-open)')].filter((d) => {
    const more = d.nextSibling && d.nextSibling.classList && d.nextSibling.classList.contains('ll-more');
    return d.scrollHeight > d.clientHeight + 1 !== !!more;
  }).length);
  assert.equal(cut, 0, 'descriptions cut without "more", or "more" on text that fits');
  await context.close();
});

test('A lock pop-up that fades out does not leave the widget hidden (review 4)', async () => {
  const { context, page } = await newPage();
  await context.route('**/fade-page.html', (r) => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>#lock{position:fixed;inset:0;background:#0006;opacity:0;visibility:hidden;transition:opacity .4s,visibility .4s}#lock.open{opacity:1;visibility:visible}</style></head><body>' +
    '<a class="card" data-tier="teacher" data-title="Ladder Talk" href="/x">Ladder Talk</a><div id="lock"><button id="lock-close">Close</button></div>' +
    '<script>document.querySelector("a.card").addEventListener("click",function(e){e.preventDefault();document.getElementById("lock").classList.add("open");});document.getElementById("lock-close").onclick=function(){document.getElementById("lock").classList.remove("open");};</script>' +
    '<script src="/dist/ll-assistant/ll-assistant.js" defer data-avoid="#lock"></script></body></html>' }));
  await openWidget(page, `${BASE}/fade-page.html`);
  const { el } = await ask(page, 'adult business english');
  await el.locator('.ll-card-title', { hasText: 'Ladder Talk' }).click();
  await page.waitForFunction(() => document.getElementById('ll-assistant').hidden);
  await page.locator('#lock-close').click();
  await page.waitForFunction(() => !document.getElementById('ll-assistant').hidden, null, { timeout: 3000 });
  await context.close();
});
