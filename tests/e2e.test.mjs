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
const { core } = require(path.join(ROOT, 'src', 'll-assistant-app.js'));
const { checkQuestion, runQuestion } = require(path.join(ROOT, 'tests', 'check.js'));
const CLARITY_JS = require.resolve('clarity-js/build/clarity.min.js');
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8')));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const GAME = Object.fromEntries(source.games.map((g) => [g.id, g]));
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = `${BASE}/demo.html`;
const EVENTS = ['ll_ai_offered', 'll_download_started', 'll_download_finished', 'll_fallback_shown', 'll_game_click',
  'll_plan_shown', 'll_plan_send_open', 'll_plan_send_email', 'll_plan_send_copy', 'll_plan_send_share', 'll_plan_opened_from_link'];
const EVENT_RE = new RegExp(EVENTS.join('|'), 'g');
const MB = Math.ceil(cat.model.bytes / 1048576);
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
    // Layout shift, split by cause: a shift with a moved node inside the widget
    // (or the widget itself) is the widget's; anything else is the demo page's.
    window.__cls = 0; window.__clsWidget = 0; window.__clsShifts = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          const nodes = (e.sources || []).map((src) => src.node).filter(Boolean);
          const ours = nodes.some((n) => { const r = document.getElementById('ll-assistant'); return r && (n === r || r.contains(n)); });
          if (ours) window.__clsWidget += e.value;
          window.__clsShifts.push({ value: e.value, widget: ours, nodes: nodes.map((n) => n.nodeName + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : '')) });
        }
      }).observe({ type: 'layout-shift', buffered: true });
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

// The AI offer starts as one line; this opens the full offer card.
async function expandOffer(page) {
  if (!(await page.locator('#ll-assistant .ll-offer .ll-btn').count())) await page.locator('#ll-assistant .ll-offer .ll-link').click();
}

// The games in the order the lesson plan shows them: the steps (or the one
// game of a single-game plan), then "Other games that fit".
function planItems(turn) {
  const p = turn.plan;
  const ids = (p.kind === 'single' ? [p.item] : p.steps.map((st) => st.ids)).concat(p.others);
  return ids.map((list) => turn.items.find((it) => (it.ids || [it.id])[0] === list[0]));
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
    // The real model's picks for "adult business english" on 2026-10-11 (round 7).
    if (/qqoff/.test(user)) picks = ['finance_MiniBusinessTycoonSuper', 'speaking_QuickFireFlashcards', 'speaking_DoctorVisit'].filter((id) => cands.some((c) => c.id === id));
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
  assert.equal(await page.evaluate(() => window.__clsWidget), 0, 'layout shift caused by the widget: ' + JSON.stringify(await page.evaluate(() => window.__clsShifts)));
  assert.equal(await page.locator('#ll-assistant').getAttribute('data-clarity-mask'), 'true');
  assert.equal(await page.locator('#ll-assistant').evaluate((b) => getComputedStyle(b).position), 'fixed');

  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  // Round 6: the finder (matching, plan, sending, word list) comes only now, once, with the catalogue.
  const openPaths = requests.map((r) => new URL(r.url).pathname).filter((p) => !p.endsWith('/demo.html'));
  assert.deepEqual(openPaths.filter((p) => /ll-assistant-app\.js$/.test(p)), ['/dist/ll-assistant/ll-assistant-app.js'], 'the finder loads once, on open');
  assert.ok(requests.some((r) => /ll-assistant-app\.js\?v=[0-9a-f]{10}$/.test(r.url)), 'by its versioned name');
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
    const shown = planItems(turn);
    assert.deepEqual(shown.map((it) => (it.ids || [it.id]).join()).sort(), turn.items.map((it) => (it.ids || [it.id]).join()).sort(), `${q.id}: the plan shows every game once`);
    shown.forEach((it, i) => {
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
    assert.equal(await el.locator('.ll-pl-h').innerText(), lang === 'zh' ? '你嘅課堂安排' : 'Your lesson plan', `${q.id}: plan heading`);
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
  const uploads = (await page.evaluate(() => window.__up.join('\n'))).replace(EVENT_RE, '');
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
  // One number everywhere: the one-line offer and the button both show model.bytes (fix 2).
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-link').innerText(), `Use on-device AI (${MB} MB)`);
  await expandOffer(page);
  const btn = page.locator('#ll-assistant .ll-offer .ll-btn');
  const label = await btn.innerText();
  assert.equal(label, `Download AI · ${MB} MB · one-time download`);
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
  await expandOffer(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => /Downloading AI · [1-9]\d?% · \d+ of \d+ MB/.test(document.querySelector('#ll-assistant .ll-progress-text')?.textContent || ''));
  assert.match(await page.locator('#ll-assistant .ll-progress-text').innerText(), new RegExp(` of ${MB} MB$`), 'progress shows the same size');
  assert.ok(await page.locator('#ll-assistant .ll-bar span').evaluate((s) => parseFloat(s.style.width)) > 0);
  await page.locator('#ll-assistant .ll-offer button', { hasText: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn').first().isVisible(), true);
  await context.close();
});

test('AI mode (fake model): free-first, lesson length, kid-themed order, fixed question, bad output, crash', async () => {
  const { context, page, errors } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await openWidget(page);
  await expandOffer(page);
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
    assert.equal(m.lock, `13px|400|wrap|1px ${'rgb(229, 231, 235)'}`, `${tag}: lock line 13px normal weight, normal wrapping; header line`);
    // Fix 3: the lock line uses the full width under the title; the close button sits on the title row only.
    const h = await page.evaluate(() => {
      const q = (s) => document.querySelector('#ll-assistant ' + s);
      const span = q('.ll-privacy span'), r = document.createRange();
      r.selectNodeContents(span);
      const lines = [...r.getClientRects()];
      const p = q('.ll-privacy').getBoundingClientRect(), pad = parseFloat(getComputedStyle(q('.ll-privacy')).paddingRight);
      const title = q('.ll-title').getBoundingClientRect(), close = q('.ll-close').getBoundingClientRect();
      return { first: lines[0].right, room: p.right - pad, lines: new Set(lines.map((l) => Math.round(l.top))).size, closeMid: (close.top + close.bottom) / 2, titleMid: (title.top + title.bottom) / 2, closeBottom: close.bottom, lockTop: p.top };
    });
    assert.ok(h.lines === 1 || h.room - h.first < 60, `${tag}: first line of the lock sentence ends ${Math.round(h.room - h.first)}px before the edge`);
    assert.ok(Math.abs(h.closeMid - h.titleMid) <= 3, `${tag}: close button centred on the title row`);
    assert.ok(h.closeBottom <= h.lockTop + 1, `${tag}: close button above the lock line`);
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
      const list = [...turns[0].querySelectorAll('.ll-cards')].find((l) => l.querySelectorAll(':scope > .ll-card').length > 1);
      const cards = list ? [...list.querySelectorAll(':scope > .ll-card')].map((c) => c.getBoundingClientRect()) : [];
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


// ---------- this round: first open, lesson plan, send to laptop, AI note gap ----------

const SHOTS = path.join(ROOT, 'tests', 'results', 'screenshots');
// The site's Google Fonts, fetched by the test runner (TLS checked there) when online.
const siteFonts = (page) => page.route(/fonts\.(googleapis|gstatic)\.com/, async (r) => { try { await r.fulfill({ response: await r.fetch() }); } catch (e) { await r.abort(); } });
// For a screenshot of a whole plan: the panel grows to fit (screenshots only).
const STRETCH = '#ll-assistant .ll-panel{height:auto!important;max-height:none!important}#ll-assistant .ll-log{overflow:visible!important}';
async function shot(page, name, full) {
  await page.evaluate(() => document.fonts.ready);
  if (full) await page.addStyleTag({ content: STRETCH });
  await page.waitForTimeout(150);
  const file = path.join(SHOTS, name + '.png');
  if (full) await page.locator('#ll-assistant .ll-panel').screenshot({ path: file });
  else await page.screenshot({ path: file });
  assert.ok(fs.statSync(file).size > 5000, name);
  if (full) await page.evaluate(() => [...document.querySelectorAll('style')].pop().remove());
}

test('First open: the AI offer is one line on every screen size; all three examples sit above the composer (fix 1)', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 1280, height: 800 }]) {
    const { context, page } = await newPage({ fakeGpu: true, viewport });
    await siteFonts(page);
    await openWidget(page, DEMO + '?site=1');
    const tag = `${viewport.width}px`;
    assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
    const offer = await page.locator('#ll-assistant .ll-offer').evaluate((o) => ({ min: o.classList.contains('ll-offer-min'), buttons: [...o.querySelectorAll('button')].map((b) => b.textContent) }));
    assert.deepEqual(offer, { min: true, buttons: [`Use on-device AI (${MB} MB)`] }, `${tag}: one line`);
    await page.evaluate(() => document.fonts.ready);
    const fit = await page.evaluate(() => {
      const comp = document.querySelector('#ll-assistant .ll-composer').getBoundingClientRect(), log = document.querySelector('#ll-assistant .ll-log').getBoundingClientRect();
      return [...document.querySelectorAll('#ll-assistant .ll-intro .ll-chip')].map((c) => { const r = c.getBoundingClientRect(); return r.top >= log.top && r.bottom <= log.bottom && r.bottom <= comp.top; });
    });
    assert.equal(fit.length, 3);
    if (viewport.width >= 375) assert.deepEqual(fit, [true, true, true], `${tag}: every example chip fully visible above the composer`);
    await shot(page, `first-open-${viewport.width}`);
    // Tapping the line opens the full offer; a message closes it again.
    await page.locator('#ll-assistant .ll-offer .ll-link').click();
    assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn').innerText(), `Download AI · ${MB} MB · one-time download`);
    await ask(page, 'Age 8 phonics');
    assert.equal(await page.locator('#ll-assistant .ll-offer').evaluate((o) => o.classList.contains('ll-offer-min')), true);
    await context.close();
  }
});

test('Lesson plan: heading, summary, steps with minutes, parts, other games, kid note, follow-ups (Feature 1)', async () => {
  const { context, page, errors } = await newPage({ viewport: { width: 1280, height: 800 } });
  await openWidget(page);
  // 3 games, 45 minutes, Main without parts: Warm-up / Main activity / Wrap-up with 10/25/10.
  let r = await ask(page, 'P5 student, writing a story, 45 mins');
  assert.equal(r.turn.plan.kind, 'multi');
  assert.equal(await r.el.locator('.ll-pl-h').innerText(), 'Your lesson plan');
  assert.equal(await r.el.locator('.ll-pl-t').innerText(), 'Suggested timing');
  assert.deepEqual(await r.el.locator('.ll-pl-st').allInnerTexts(), ['Warm-up · 10 min', 'Main activity · 25 min', 'Wrap-up · 10 min']);
  assert.deepEqual(await r.el.locator('.ll-pl-s').allInnerTexts(), ['All 3 steps are in the Parent plan.']);
  assert.equal(await r.el.locator('.ll-pl-a').innerText(), 'Every game can be stopped at any time, so adjust as you go.');
  // Each step is a full card: the whole card opens the game (paid: the library).
  assert.equal(await r.el.locator('.ll-pl .ll-card button.ll-card-title').count(), 3);
  // 2 games, no length: labels, no minutes, no "Suggested timing".
  r = await ask(page, 'P3 listening');
  assert.deepEqual(await r.el.locator('.ll-pl-st').allInnerTexts(), ['Warm-up', 'Main activity']);
  assert.equal(await r.el.locator('.ll-pl-t').count(), 0);
  assert.ok(!(await r.el.innerText()).match(/\d+ min/), 'no minutes without a stated length');
  // Single-game plan in Chinese: English part names as in the game (2A), 1B join, other games that fit.
  r = await ask(page, '中二 時態 45分鐘');
  assert.equal(r.turn.plan.kind, 'single');
  assert.equal(await r.el.locator('.ll-pl-h').innerText(), '你嘅課堂安排');
  assert.deepEqual(await r.el.locator('.ll-pl-pn').allInnerTexts(), ['Lessons', 'Find the Clue', 'Fill in the Blanks', 'Sentence Correction']);
  assert.deepEqual(await r.el.locator('.ll-pl-pm').allInnerTexts(), ['15 分鐘', '10 分鐘', '10 分鐘', '10 分鐘']);
  assert.equal(await r.el.locator('.ll-pl-pl').innerText(), '建議時間');
  assert.equal(await r.el.locator('.ll-pl-o').innerText(), '其他啱用嘅遊戲');
  assert.equal(await r.el.locator('.ll-pl-a').innerText(), '每隻遊戲都可以隨時停，時間可以自己調。');
  assert.deepEqual(await r.el.locator('.ll-pl-s').allInnerTexts(), ['呢隻遊戲喺家長版。']);
  r = await ask(page, 'adult business english');
  assert.deepEqual(await r.el.locator('.ll-pl-pn').allInnerTexts(), ['Warm-up', 'Words', 'Discuss', 'Practice + Real Life'], '1B');
  assert.equal(await r.el.locator('.ll-pl-pl').innerText(), 'Steps');
  // Kid note (6A): one small line right before the first kid-themed card.
  assert.equal(r.turn.kidNote, true, 'adult business english has kid-themed Money English games');
  const before = await r.el.evaluate((bot) => { const n = bot.querySelector('.ll-cards > li.ll-small'); return n && n.nextElementSibling && n.nextElementSibling.textContent.includes('Kid-themed'); });
  assert.ok(before, 'kid note right before the first kid-themed card');
  assert.equal(await r.el.locator('.ll-cards > li.ll-small').count(), 1);
  // Follow-ups rebuild the plan with new games only.
  const shown = r.turn.ids;
  r = await ask(page, 'any other recommendations');
  assert.ok(r.turn.plan, 'a follow-up is a plan too');
  assert.ok(r.turn.ids.every((id) => !shown.includes(id)), 'no game shown twice');
  // The plan event: fixed name and payload.
  // A Chinese 3-game plan: the step labels in Chinese.
  r = await ask(page, '小五學生 寫故事 45分鐘');
  assert.deepEqual(await r.el.locator('.ll-pl-st').allInnerTexts(), ['暖身 · 10 分鐘', '主要活動 · 25 分鐘', '總結 · 10 分鐘']);
  assert.equal(await r.el.locator('.ll-pl-t').innerText(), '建議時間');
  const g = (await calls(page)).gtag.filter((c) => c[1] === 'll_plan_shown');
  assert.equal(g.length, 6);
  for (const c of g) assert.deepEqual(c, ['event', 'll_plan_shown', { event_category: 'll_assistant' }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Send this plan, no host form: email via the mail app, copy link, share on phones; nothing in the page (Feature 2)', async () => {
  const { context, page, errors, requests } = await newPage({ viewport: { width: 375, height: 667 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await openWidget(page);
  const r = await ask(page, 'P5 student, writing a story, 45 mins');
  const n0 = requests.length;
  await r.el.locator('.ll-sh-b').click();
  assert.equal(await r.el.locator('.ll-sh-b').innerText(), 'Send this plan to my laptop');
  assert.equal(await r.el.locator('.ll-sh-b').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await r.el.locator('.ll-sh-r button').allInnerTexts(), ['Email it to myself', 'Copy link'], 'no Share on a desktop browser');
  assert.equal(await r.el.locator('.ll-sh-n').innerText(), 'This uses your own mail app. Nothing is sent to Ladder Lessons.');
  // The plan stays on screen; nothing is blocked behind the panel.
  assert.equal(await r.el.locator('.ll-pl .ll-card').count(), 3);
  // Copy: the link in the clipboard, "Copied" for 2 seconds.
  await r.el.locator('.ll-sh-r button', { hasText: 'Copy link' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#ll-assistant .ll-sh-r button')].some((b) => b.textContent === 'Copied'));
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, new RegExp('^' + BASE.replace(/[.]/g, '\\.') + '/library#llplan=m45e\\.writing_[A-Za-z]+\\.writing_[A-Za-z]+\\.writing_[A-Za-z]+$'));
  const back = core.parsePlanCode(link.split('#llplan=')[1], cat);
  assert.deepEqual(back.steps.map((st) => st.item.id), r.turn.plan.steps.map((st) => st.ids[0]));
  await page.waitForTimeout(1300);
  assert.ok((await r.el.locator('.ll-sh-r button').allInnerTexts()).includes('Copied'), '"Copied" still shown after about 1.5 s');
  await page.waitForFunction(() => [...document.querySelectorAll('#ll-assistant .ll-sh-r button')].map((b) => b.textContent).join() === 'Email it to myself,Copy link', null, { timeout: 2000 });
  // Email: a button, no mailto address anywhere in the page.
  await r.el.locator('.ll-sh-r button', { hasText: 'Email it to myself' }).click();
  await page.waitForTimeout(200);
  const html = await page.evaluate(() => document.getElementById('ll-assistant').outerHTML);
  assert.ok(!/mailto|llplan|href=/.test(html), 'no address or link in the widget DOM');
  // The only "request" is the hand-off to the mail app: mailto with no recipient, the link and the steps.
  const extra = requests.slice(n0).map((x) => x.url);
  assert.equal(extra.length, 1, 'nothing sent anywhere: ' + extra.join(', '));
  assert.equal(decodeURIComponent(extra[0]), decodeURIComponent(core.mailtoLink(cat, back, link, 'en')));
  assert.match(extra[0], /^mailto:\?subject=My%20Ladder%20Lessons%20lesson%20plan&body=/);
  const ev = await eventNames(page);
  for (const e of ['ll_plan_send_open', 'll_plan_send_copy', 'll_plan_send_email']) assert.ok(ev.includes(e), e);
  for (const c of (await calls(page)).gtag) assert.deepEqual(c, ['event', c[1], { event_category: 'll_assistant' }]);
  await shot(page, 'send-panel-fallback-375');
  assert.deepEqual(errors, []);
  await context.close();

  // A phone: Share opens the share sheet with the link.
  const phone = await newPage({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', viewport: { width: 375, height: 667 } });
  await phone.context.addInitScript(() => { window.__shared = []; navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); }; });
  await openWidget(phone.page);
  const p = await ask(phone.page, 'Age 9 writing 30 minutes');
  await p.el.locator('.ll-sh-b').click();
  await p.el.locator('.ll-sh-r button', { hasText: 'Share' }).click();
  const shared = await phone.page.evaluate(() => window.__shared);
  assert.equal(shared.length, 1);
  assert.match(shared[0].url, /\/library#llplan=s30e\.writing_RolePlayWriting\./);
  assert.ok((await eventNames(phone.page)).includes('ll_plan_send_share'));
  await phone.context.close();
});

test('Send this plan, host form: sendPlan called once, its form first, copy line under it, "Sent" after success (Feature 2)', async () => {
  const { context, page, errors } = await newPage({ viewport: { width: 375, height: 667 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await openWidget(page, DEMO + '?host=1');
  const r = await ask(page, 'Form 2 tenses 45 minutes');
  await r.el.locator('.ll-sh-b').click();
  const calls1 = await page.evaluate(() => window.__hostSendPlan);
  assert.equal(calls1.length, 1, 'sendPlan called once');
  // Exactly what the spec hands over: the link and an empty mount (plus lang and done). Nothing typed.
  assert.deepEqual(calls1[0].keys, ['done', 'lang', 'mount', 'url']);
  assert.equal(calls1[0].mountEmpty, true, 'the mount is empty when sendPlan is called');
  for (const tok of queryTokens('Form 2 tenses 45 minutes').filter((t) => !/^\d+$/.test(t) && !['tenses'].includes(t))) assert.ok(!containsToken(JSON.stringify(calls1[0]), tok), tok);
  // 2.10: the plan stays on screen with the host form open.
  assert.equal(await r.el.locator('.ll-pl .ll-card').count(), 3);
  assert.ok(await r.el.locator('.ll-pl .ll-card').first().isVisible());
  assert.match(calls1[0].url, new RegExp('^' + BASE.replace(/[.]/g, '\\.') + '/library#llplan=s45e\\.grammar_TenseStudio(\\.[A-Za-z0-9_~]+){0,2}$'));
  // The host's form comes first, then "or copy the link", then the note.
  const order = await r.el.locator('.ll-sh-p').evaluate((p) => [...p.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className || c.tagName));
  assert.deepEqual(order, ['ll-sh-m', 'll-link', 'll-small ll-sh-n']);
  assert.equal(await r.el.locator('.ll-sh-p .ll-link').innerText(), 'or copy the link');
  assert.equal(await r.el.locator('.ll-sh-n').innerText(), 'This sends your email address and this list of games to Ladder Lessons. Nothing you typed is included.');
  assert.equal(await r.el.locator('.ll-sh-r').count(), 0, 'no mail-app button in host mode');
  assert.ok(!/mailto/.test(await page.evaluate(() => document.getElementById('ll-assistant').outerHTML)));
  await shot(page, 'send-panel-host-375');
  // The host's own form gets its events (the widget does not stop them).
  await page.locator('.ll-sh-m input').fill('teacher@example.com');
  assert.equal(await page.locator('.ll-sh-m input').inputValue(), 'teacher@example.com');
  await page.locator('.ll-sh-m button').click();
  await page.waitForFunction(() => (document.querySelector('#ll-assistant .ll-sh-d') || {}).textContent === 'Sent. Check your inbox on your laptop.');
  assert.equal((await page.evaluate(() => window.__hostSendPlan)).length, 1, 'still one call');
  // Closing and opening the panel keeps the form and "Sent", and does not call sendPlan again.
  await r.el.locator('.ll-sh-b').click();
  assert.equal(await r.el.locator('.ll-sh-p').isVisible(), false);
  await r.el.locator('.ll-sh-b').click();
  assert.equal(await r.el.locator('.ll-sh-d').innerText(), 'Sent. Check your inbox on your laptop.');
  assert.equal(await page.locator('.ll-sh-m input').inputValue(), 'teacher@example.com');
  assert.equal((await page.evaluate(() => window.__hostSendPlan)).length, 1, 'one call per plan');
  const ev = await eventNames(page);
  assert.equal(ev.filter((e) => e === 'll_plan_send_email').length, 1);
  // Nothing typed in the host form reaches the widget's analytics.
  assert.ok(!JSON.stringify(await calls(page)).includes('teacher@example.com'));
  // "or copy the link"
  await r.el.locator('.ll-sh-p .ll-link').click();
  await page.waitForFunction(() => document.querySelector('#ll-assistant .ll-sh-p .ll-link').textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), calls1[0].url);
  // A host that returns a Promise instead of calling done().
  await page.evaluate(() => { window.__p = 0; window.LLAssistantHost = { sendPlan: () => { window.__p++; return new Promise((res) => setTimeout(res, 100)); } }; });
  const r2 = await ask(page, 'P3 listening');
  await r2.el.locator('.ll-sh-b').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#ll-assistant .ll-sh-d')].some((d) => d.textContent === 'Sent. Check your inbox on your laptop.'));
  assert.equal(await page.evaluate(() => window.__p), 1);
  // A host form that fails: the mail app, copy and share instead, with the mail-app note.
  await page.evaluate(() => { window.LLAssistantHost = { sendPlan: () => { throw new Error('form broke'); } }; });
  const r3 = await ask(page, 'Age 9 writing 30 minutes');
  await r3.el.locator('.ll-sh-b').click();
  assert.deepEqual(await r3.el.locator('.ll-sh-r button').allInnerTexts(), ['Email it to myself', 'Copy link']);
  assert.equal(await r3.el.locator('.ll-sh-n').innerText(), 'This uses your own mail app. Nothing is sent to Ladder Lessons.');
  assert.deepEqual(errors, []);
  await context.close();
});

test('A plan link opens the widget with the saved plan, never runs the model, skips unknown games (Feature 2)', async () => {
  const code = 'm45z.writing_RolePlayWriting.nope_NotAGame.writing_ChainStory.writing_DetectivesNotebook';
  let { context, page, requests, errors } = await newPage({ fakeGpu: true, worker: FAKE_WORKER, viewport: { width: 1280, height: 800 } });
  await siteFonts(page);
  await page.goto(`${BASE}/library#llplan=${code}`);
  await page.waitForFunction(() => document.querySelector('#ll-assistant .ll-pl-h'));
  assert.equal(await page.locator('#ll-assistant .ll-pl-h').innerText(), '你儲存咗嘅課堂安排');
  const turns = await page.evaluate(() => LLAssistant.internals.turns());
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].plan.steps.map((st) => [st.role, st.ids[0], st.min]), [['warmup', 'writing_RolePlayWriting', 10], ['main', 'writing_ChainStory', 25], ['wrapup', 'writing_DetectivesNotebook', 10]]);
  assert.equal(await page.locator('#ll-assistant .ll-title').innerText(), '課堂遊戲小助手', 'the plan\'s language');
  assert.ok((await eventNames(page)).includes('ll_plan_opened_from_link'));
  await page.waitForTimeout(300);
  assert.ok(!requests.some((r) => /ll-worker\.js|web-llm\.js/.test(r.url)), 'the model never runs for a saved plan');
  await shot(page, 'saved-plan-zh-1280', true);
  assert.deepEqual(errors, []);
  await context.close();

  // No valid game: the usual empty state, once the catalogue has loaded.
  ({ context, page } = await newPage());
  await page.goto(`${DEMO}#llplan=m30e.nope_A.nope_B`);
  await page.waitForFunction(() => window.LLAssistant && LLAssistant.internals.state().open && LLAssistant.internals.state().cat);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#ll-assistant .ll-intro').isVisible(), true);
  assert.equal(await page.evaluate(() => LLAssistant.internals.turns().length), 0);
  // A link opened on a page that is already there (hash change).
  await page.evaluate(() => { location.hash = 'llplan=s45e.grammar_TenseStudio.grammar_Detective'; });
  await page.waitForFunction(() => document.querySelector('#ll-assistant .ll-pl-h'));
  assert.equal(await page.locator('#ll-assistant .ll-pl-h').innerText(), 'Your saved lesson plan');
  assert.equal((await page.evaluate(() => LLAssistant.internals.turns()))[0].plan.kind, 'single');
  await context.close();
});

test('The AI note sits 16px below the bottom of the card shadow (visual 7)', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: FAKE_WORKER, viewport: { width: 375, height: 667 } });
  await siteFonts(page);
  await openWidget(page, DEMO + '?site=1');
  await expandOffer(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  for (const text of ['Age 9 listening 30 min', 'Form 2 tenses 45 minutes']) {
    const r = await ask(page, text);
    assert.equal(r.turn.source, 'ai');
    // Measured at rest: no card hovered or lifted.
    await page.mouse.move(1, 1);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(250);
    const m = await r.el.evaluate((bot) => {
      const foot = bot.querySelector('.ll-foot'), list = foot.previousElementSibling;
      const cards = list.querySelectorAll(':scope > .ll-card'), card = cards[cards.length - 1];
      // The shadow's lowest edge: y offset + blur + spread of each shadow layer.
      const layers = getComputedStyle(card).boxShadow.split(/,(?![^(]*\))/).map((l) => (l.match(/-?\d+(\.\d+)?px/g) || []).map(parseFloat));
      const reach = Math.max(0, ...layers.map((n) => (n[1] || 0) + (n[2] || 0) + (n[3] || 0)));
      return { gap: foot.getBoundingClientRect().top - (card.getBoundingClientRect().bottom + reach), reach, marginTop: getComputedStyle(foot).marginTop };
    });
    assert.equal(m.marginTop, '16px');
    assert.ok(m.reach >= 4, 'card shadow measured: ' + m.reach);
    assert.ok(Math.abs(m.gap - 16) <= 0.5, `${text}: gap from the bottom of the shadow ${m.gap}px`);
  }
  await page.locator('#ll-assistant .ll-foot').last().scrollIntoViewIfNeeded();
  await shot(page, 'ai-note-gap-375');
  await context.close();
});

test('Screenshots of this round (375 and 1280, site fonts): plans in English and Chinese, send panels', async () => {
  for (const width of [375, 1280]) {
    const { context, page } = await newPage({ viewport: { width, height: width < 500 ? 667 : 800 } });
    await siteFonts(page);
    await openWidget(page, DEMO + '?site=1&llai=off');
    await ask(page, 'P5 student, writing a story, 45 mins');
    await shot(page, `plan-3-steps-minutes-en-${width}`);
    await shot(page, `plan-3-steps-minutes-en-${width}-full`, true);
    await ask(page, 'P3 listening');
    await shot(page, `plan-2-steps-no-minutes-${width}-full`, true);
    await ask(page, '中二 時態 45分鐘');
    await shot(page, `plan-single-zh-${width}`);
    await shot(page, `plan-single-zh-${width}-full`, true);
    await lastBot(page).locator('.ll-sh-b').click();
    await shot(page, `send-panel-fallback-zh-${width}-full`, true);
    await context.close();
    const host = await newPage({ viewport: { width, height: width < 500 ? 667 : 800 } });
    await siteFonts(host.page);
    await openWidget(host.page, DEMO + '?site=1&llai=off&host=1');
    await ask(host.page, 'Age 9 writing 30 minutes');
    await lastBot(host.page).locator('.ll-sh-b').click();
    await shot(host.page, `send-panel-host-en-${width}-full`, true);
    await host.context.close();
  }
});

// ---------- review round 5 ----------

test('Small talk: a short polite reply, the open question stays open, its chips stay active (C6)', async () => {
  const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
  await openWidget(page);
  await ask(page, 'Age 8');
  let r = await ask(page, 'thanks');
  assert.equal(r.turn.kind, 'smalltalk');
  assert.equal(r.text, 'You’re welcome. Ask me again any time.');
  assert.equal(await page.locator('#ll-assistant .ll-bot p', { hasText: 'Which skill do you want to practise?' }).count(), 1, 'the question is not repeated');
  // The reply is on screen.
  assert.ok(await r.el.evaluate((n) => { const l = n.closest('.ll-log').getBoundingClientRect(), b = n.getBoundingClientRect(); return b.top >= l.top && b.bottom <= l.bottom; }), 'reply visible');
  // The question is still open: a chip still works.
  const chips = page.locator('#ll-assistant .ll-chip:has(.ll-num)');
  assert.equal(await chips.first().isDisabled(), false);
  r = await ask(page, 'ok');
  assert.equal(r.text, 'Sure. Ask me again any time.');
  // In Chinese: the language switch redraws the conversation; the chips stay active.
  r = await ask(page, '多謝');
  assert.equal(r.text, '唔使客氣，有需要再問我。');
  assert.equal(await chips.first().isDisabled(), false, 'chips of the open question stay active after a redraw');
  r = await ask(page, '2');
  assert.equal(r.turn.kind, 'picks');
  assert.ok(r.turn.ids.every((id) => cat.byId[id].skill === 'writing'), 'choice 2 (writing) answers the question asked before the small talk');
  await context.close();
});

test('A plan link on an open conversation: its own group, the old question closed, the model never asked (Feature 2)', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: FAKE_WORKER, viewport: { width: 1280, height: 800 } });
  // Count every message to the model worker.
  await context.addInitScript(() => {
    window.__chats = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m) { if (m && m.type === 'chat') window.__chats++; return post.apply(this, arguments); };
  });
  await openWidget(page);
  await expandOffer(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  await ask(page, 'Age 8');
  const before = await page.evaluate(() => window.__chats);
  await page.evaluate(() => { location.hash = 'llplan=m30e.listening_NumberNinja.listening_AnnouncementStation'; });
  await page.waitForFunction(() => document.querySelector('#ll-assistant .ll-pl-h'));
  assert.equal(await page.locator('#ll-assistant .ll-pl-h').innerText(), 'Your saved lesson plan');
  assert.equal(await page.evaluate(() => window.__chats), before, 'no message to the model for a saved plan');
  const groups = await page.evaluate(() => [...document.querySelectorAll('#ll-assistant .ll-log > .ll-turn')].map((t) => [...t.children].map((c) => c.classList.contains('ll-you') ? 'you' : (c.querySelector('.ll-pl') ? 'plan' : 'bot')).join(',')));
  assert.deepEqual(groups, ['you,bot', 'plan'], 'the saved plan is its own group');
  // The old "Which skill?" question is closed: "2" is a new message, not choice 2.
  const r = await ask(page, '2');
  assert.notEqual(r.turn.kind, 'picks');
  await context.close();
});

test('Clarity (real library) with the site\'s email form inside the widget: no fingerprint of the typed email (privacy)', async () => {
  const { context, page } = await newPage();
  await context.addInitScript(() => {
    window.__up = [];
    window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    window.clarity('start', { projectId: 'll-test', delay: 100, upload: (p) => window.__up.push(typeof p === 'string' ? p : JSON.stringify(p)) });
    window.__hostSends = [];
    window.LLAssistantHost = { sendPlan: (o) => {
      const input = document.createElement('input'); input.type = 'email';
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Send';
      // The form reads the address on click, as the widget's README says.
      btn.addEventListener('click', () => { window.__hostSends.push(input.value); o.done(); });
      o.mount.appendChild(input); o.mount.appendChild(btn);
    } };
  });
  await context.route('**/clarity-host.html', (r) => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><p>x</p>' +
    '<script src="/dist/ll-assistant/ll-assistant.js" defer></script></body></html>' }));
  await page.goto(`${BASE}/clarity-host.html`);
  await page.addScriptTag({ path: CLARITY_JS });
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  await page.waitForTimeout(1000);
  const r = await ask(page, 'Form 2 tenses 45 minutes');
  await r.el.locator('.ll-sh-b').click();
  const email = 'teacher.chan@school.example.org';
  await page.locator('#ll-assistant .ll-sh-m input').click();
  await page.keyboard.type(email, { delay: 0 });
  await page.locator('#ll-assistant .ll-sh-m button').click();
  assert.deepEqual(await page.evaluate(() => window.__hostSends), [email], 'the host form still works');
  await page.waitForFunction(() => (document.querySelector('#ll-assistant .ll-sh-d') || {}).textContent === 'Sent. Check your inbox on your laptop.');
  await page.locator('#ll-assistant .ll-close').click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.clarity('upgrade', 'test'));
  await page.waitForTimeout(800);
  const uploads = await page.evaluate(() => window.__up.join('\n'));
  assert.ok(uploads.length > 1000, 'Clarity uploaded something');
  assert.ok(!uploads.includes('"' + clarityHash(email, 28) + '"'), 'a fingerprint of the typed email reached Clarity');
  for (const part of ['teacher', 'chan', 'school.example']) assert.ok(!uploads.includes(part), `"${part}" reached Clarity`);
  await context.close();
});

test('The send options and a small-talk reply come into view on a phone-size screen (review 5)', async () => {
  for (const host of [false, true]) {
    const { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
    await openWidget(page, DEMO + (host ? '?host=1' : ''));
    const r = await ask(page, 'Age 7, phonics, 45 min');
    await r.el.locator('.ll-sh-b').scrollIntoViewIfNeeded();
    await r.el.locator('.ll-sh-b').click();
    await page.waitForTimeout(250);
    const target = host ? '.ll-sh-m input' : '.ll-sh-r button';
    const seen = await page.evaluate((sel) => {
      const l = document.querySelector('#ll-assistant .ll-log').getBoundingClientRect();
      const n = [...document.querySelectorAll('#ll-assistant ' + sel)].pop().getBoundingClientRect();
      return n.top >= l.top && n.bottom <= l.bottom;
    }, target);
    assert.ok(seen, `${host ? 'host form' : 'Email it to myself'} visible after the click`);
    await context.close();
  }
});

test('Chinese send panel wording, both modes (spec 2.1, 2.4, 2.5, 2.9, 2.11)', async () => {
  let { context, page } = await newPage({ viewport: { width: 375, height: 667 } });
  await openWidget(page);
  let r = await ask(page, '小五學生 寫故事 45分鐘');
  assert.equal(await r.el.locator('.ll-sh-b').innerText(), '將呢堂課傳去我部電腦');
  await r.el.locator('.ll-sh-b').click();
  assert.deepEqual(await r.el.locator('.ll-sh-r button').allInnerTexts(), ['寄畀自己', '複製連結']);
  assert.equal(await r.el.locator('.ll-sh-n').innerText(), '呢度用你自己嘅 email app，唔會有嘢傳送畀 Ladder Lessons。');
  await context.close();
  ({ context, page } = await newPage({ viewport: { width: 375, height: 667 } }));
  await openWidget(page, DEMO + '?host=1');
  r = await ask(page, '小五學生 寫故事 45分鐘');
  await r.el.locator('.ll-sh-b').click();
  assert.equal(await r.el.locator('.ll-sh-p .ll-link').innerText(), '或者複製連結');
  assert.equal(await r.el.locator('.ll-sh-n').innerText(), '呢度會將你嘅 email 同呢張遊戲清單傳送畀 Ladder Lessons，唔包括你打過嘅字。');
  await page.locator('.ll-sh-m input').fill('a@b.example');
  await page.locator('.ll-sh-m button').click();
  await page.waitForFunction(() => (document.querySelector('#ll-assistant .ll-sh-d') || {}).textContent === '已寄出，喺電腦開 email 就見到。');
  assert.match((await page.evaluate(() => window.__hostSendPlan))[0].url, /#llplan=m45z\./, 'the link carries the language');
  await context.close();
});

test('The root page sends you to demo.html?site=1 (visual 8)', async () => {
  const { context, page } = await newPage();
  await page.goto(`${BASE}/`);
  await page.waitForURL(/\/demo\.html\?site=1$/);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('link[href="ll-tokens.css"]'));
  await context.close();
});

test('Cancelling a start from the cache keeps the one size on the offer (fix 2)', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: SLOW_WORKER });
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant);
  await page.evaluate(async (m) => {
    const put = async (name, url, body) => (await caches.open(name)).put(url, new Response(body));
    await put('webllm/model', m.url + 'tensor-cache.json', JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 1 }] }));
    await put('webllm/model', m.url + 'params_shard_0.bin', 'x');
    await put('webllm/model', m.url + 'tokenizer.json', '{}');
    await put('webllm/config', m.url + 'mlc-chat-config.json', '{}');
    await put('webllm/wasm', m.lib, 'x');
  }, cat.model);
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'starting');
  await page.locator('#ll-assistant .ll-offer button', { hasText: 'Cancel' }).click();
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-link').innerText(), `Use on-device AI (${MB} MB)`);
  await expandOffer(page);
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn').innerText(), `Download AI · ${MB} MB · one-time download`);
  await context.close();
});

test('The finder file loads on first open only; if it cannot load, the button says "Try again" and a second click works (round 6)', async () => {
  const { context, page, requests } = await newPage();
  let block = true;
  await context.route('**/ll-assistant-app.js*', (r) => (block ? r.abort() : r.continue()));
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.waitForTimeout(300);
  assert.ok(!requests.some((r) => /ll-assistant-app\.js/.test(r.url)), 'not fetched before the widget is opened');
  assert.equal(typeof (await page.evaluate(() => window.LLAssistant.core)), 'undefined', 'the finder is not on the page yet');
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => document.querySelector('#ll-assistant .ll-launcher-text').textContent === 'Try again');
  assert.equal(await page.locator('#ll-assistant .ll-panel').count(), 0);
  block = false;
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().open && document.querySelector('#ll-assistant .ll-panel:not([hidden])'));
  assert.equal(await page.locator('#ll-assistant .ll-launcher-text').evaluate((n) => n.textContent), 'Find a game');
  const r = await ask(page, 'Age 8 phonics');
  assert.equal(r.turn.kind, 'picks');
  await context.close();
});

test('Halloween finds Ladder Festivals in keyword mode (&llai=off) and in AI mode; Form 4 speaking does not lead with a festival game (round 6); festival + skill leads with the skill game, adult off-topic AI picks are left out (round 7)', async () => {
  const HALLOWEEN = ['Halloween activity for kids', '萬聖節 小朋友', '萬聖 活動', 'trick or treat game for kids'];
  // Keyword mode, as on demo.html?llai=off
  let { context, page } = await newPage({ fakeGpu: true });
  await openWidget(page, DEMO + '?llai=off');
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'rules');
  for (const text of HALLOWEEN) {
    const r = await ask(page, text);
    assert.equal(r.turn.source, 'rules');
    assert.equal(r.turn.ids[0], 'speaking_LadderFestivals', text);
    assert.equal(await r.el.locator('.ll-card .ll-card-title').first().innerText().then((x) => x.replace(/\s*↗\s*$/, '')), 'Ladder Festivals', `${text}: first card shown`);
  }
  // Form 4 speaking: Ladder Talk is the lesson; Festival Speaking Builder only under "Other games that fit".
  for (const text of ['Form 4 口說', '中四 speaking']) {
    const r = await ask(page, text);
    assert.equal(r.turn.plan.kind, 'single', text);
    assert.deepEqual(r.turn.plan.item, ['speaking_LadderTalk'], text);
    assert.ok(r.turn.plan.others.some((x) => x[0] === 'speaking_FestivalSentenceBuilder'), text);
  }
  // With a festival and a skill named, the festival game for that skill is the lesson (round 7);
  // with only a festival, the general festival game.
  for (const text of ['Form 4 中秋節口說', 'Form 4 Mid-Autumn speaking']) {
    const r = await ask(page, text);
    assert.deepEqual(r.turn.plan.item, ['speaking_FestivalSentenceBuilder'], text);
    assert.equal(await r.el.locator('.ll-card .ll-card-title').first().innerText().then((x) => x.replace(/\s*↗\s*$/, '')), 'Festival Speaking Builder', `${text}: the lesson card`);
  }
  const plain = await ask(page, '中秋節遊戲');
  assert.deepEqual(plain.turn.plan.item, ['speaking_LadderFestivals']);
  await context.close();

  // AI mode (a fake model that picks other games first): Ladder Festivals still leads.
  ({ context, page } = await newPage({ fakeGpu: true, worker: FAKE_WORKER }));
  await openWidget(page);
  await expandOffer(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  for (const text of HALLOWEEN) {
    const r = await ask(page, text + ' qqone');
    assert.equal(r.turn.source, 'ai', text);
    assert.equal(r.turn.ids[0], 'speaking_LadderFestivals', text);
  }
  const midAi = await ask(page, 'Form 4 中秋節口說 qqone');
  assert.equal(midAi.turn.source, 'ai');
  assert.deepEqual(midAi.turn.plan.item, ['speaking_FestivalSentenceBuilder']);
  // Round 7: the model's off-topic picks for an adult business question are left out, and the kid-themed note shows.
  for (const text of ['adult business english qqoff', '成人商業英文 qqoff']) {
    const r = await ask(page, text);
    assert.equal(r.turn.source, 'ai', text);
    assert.deepEqual(r.turn.ids, ['speaking_LadderTalk', 'finance_MiniBusinessTycoonSuper', 'finance_YoungEntrepreneur'], text);
    assert.equal(r.turn.kidNote, true, text);
    assert.equal(await r.el.locator('.ll-cards > li.ll-small').count(), 1, `${text}: kid-themed note`);
  }
  await context.close();
});
