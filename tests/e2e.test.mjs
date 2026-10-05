// Browser tests with Playwright + Chromium. Run: node tests/e2e.test.mjs (after npm run build)
//
// Chromium path: $CHROME_PATH, else /opt/pw-browsers/chromium, else installed Google Chrome.
// No real model is downloaded here. The AI path is exercised with fake workers
// that speak the same message protocol as src/ll-worker.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../scripts/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const REAL_URLS = new Set(source.games.map((g) => g.url));
const BYID = Object.fromEntries(source.games.map((g) => [g.id, g]));
const PORT = 8000 + Math.floor(Math.random() * 900);
const DEMO = `http://127.0.0.1:${PORT}/demo.html`;

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

async function newPage({ fakeGpu = false, noGpuObject = false, ua, worker } = {}) {
  const context = await browser.newContext(ua ? { userAgent: ua } : {});
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  await context.route('https://ladderlessons.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>game page</p>' }));
  // The model host is never really contacted in these tests.
  await context.route(/huggingface\.co|githubusercontent\.com/, (r) => {
    const u = r.request().url();
    if (u.endsWith('tensor-cache.json')) {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 200 * 1048576 }, { dataPath: 'params_shard_1.bin', nbytes: 80 * 1048576 }] }) });
    }
    if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'content-length': '5000000' }, body: '' });
    return r.abort();
  });
  if (worker) await context.route('**/ll-worker.js', (r) => r.fulfill({ contentType: 'text/javascript', body: worker }));
  await context.addInitScript(({ fakeGpu, noGpuObject }) => {
    if (noGpuObject) { try { delete Navigator.prototype.gpu; } catch (e) { /* ignore */ } }
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* ignore */ }
    if (fakeGpu) {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: {}, info: {} }) } });
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    }
  }, { fakeGpu, noGpuObject });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, requests, errors };
}

const panel = (page) => page.locator('#ll-assistant .ll-panel');

async function openWidget(page) {
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant && document.querySelector('#ll-assistant .ll-launcher'));
  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => { const s = LLAssistant.internals.state().ai; return s !== 'unknown' && s !== 'checking'; });
}

async function ask(page, text) {
  const before = await page.locator('#ll-assistant .ll-bot').count();
  await page.locator('#ll-assistant .ll-input').fill(text);
  await page.locator('#ll-assistant .ll-input').press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#ll-assistant .ll-bot:not(.ll-thinking)').length > n, before);
  const last = page.locator('#ll-assistant .ll-bot:not(.ll-thinking)').last();
  return {
    source: await last.getAttribute('data-source'),
    hrefs: await last.locator('a').evaluateAll((as) => as.map((a) => a.href)),
    ids: await last.locator('a[data-id]').evaluateAll((as) => as.map((a) => a.dataset.id)),
    text: await last.innerText(),
    el: last,
  };
}

const events = (page) => page.evaluate(() => window.__events.map((a) => a[1]));

// A worker that behaves like ll-worker.js but answers instantly.
const FAKE_WORKER = `
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    let p = 0;
    const t = setInterval(() => { p += 0.25; postMessage({ type: 'progress', progress: Math.min(p, 1), text: '' });
      if (p >= 1) { clearInterval(t); postMessage({ type: 'ready', ms: 5 }); } }, 30);
  } else if (m.type === 'chat') {
    const user = m.messages[m.messages.length - 1].content;
    const s = m.schema;
    const ids = (s.properties || s.anyOf[0].properties).picks.items.enum;
    if (/CRASH/.test(user)) { setTimeout(() => { throw new Error('GPU device lost'); }); return; }
    let text = JSON.stringify({ picks: ['not_a_game', ids[0], 'https://evil.example.com'] });
    if (/BAD/.test(user)) text = 'Sure! Visit https://evil.example.com for free games.';
    if (/ASK/.test(user) && s.anyOf) text = JSON.stringify({ ask: 'How old are they? 1) 4-6 2) 7-9 3) Adults' });
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

test('WebGPU disabled: zero page-load cost, fallback works for all 15 questions', async () => {
  const { context, page, requests, errors } = await newPage();
  await page.goto(DEMO);
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);

  // Chromium with WebGPU disabled keeps navigator.gpu but returns no adapter.
  assert.equal(await page.evaluate(async () => !navigator.gpu || !(await navigator.gpu.requestAdapter())), true, 'WebGPU should be off in this test');
  const loadUrls = requests.map((u) => new URL(u).pathname);
  assert.deepEqual(loadUrls.filter((p) => !p.endsWith('/demo.html')).sort(), ['/dist/ll-assistant/ll-assistant.css', '/dist/ll-assistant/ll-assistant.js'], 'page load fetched more than the widget script + css: ' + loadUrls.join(', '));
  assert.equal(await page.evaluate(() => window.__cls), 0, 'layout shift');
  assert.equal(await page.locator('#ll-assistant').getAttribute('data-clarity-mask'), 'True');
  assert.equal(await page.locator('#ll-assistant .ll-launcher').evaluate((b) => getComputedStyle(b).position), 'absolute');
  assert.equal(await page.locator('#ll-assistant').evaluate((b) => getComputedStyle(b).position), 'fixed');

  await page.locator('#ll-assistant .ll-launcher').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'rules');
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().device.reason), 'no-gpu-adapter');
  assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false, 'no AI offer without WebGPU');
  assert.match(await page.locator('#ll-assistant .ll-notice').innerText(), /Nothing you type leaves your device/);
  assert.doesNotMatch(await panel(page).innerText(), /sorry|error|not supported|unavailable/i);

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
    const r = await ask(page, q.text);
    for (const h of r.hrefs) assert.ok(REAL_URLS.has(h), `${q.id}: rendered link not in catalogue: ${h}`);
    assert.ok(!r.text.includes('evil.example'), 'injected URL rendered');
    if (q.expect === 'none') { assert.equal(r.hrefs.length, 0, q.id); continue; }
    assert.ok(r.ids.length >= 1 && r.ids.length <= 3, q.id);
    assert.ok(r.ids.some((id) => q.anyOf.includes(id)), `${q.id}: ${r.ids.join(', ')}`);
    if (q.freeFirst) assert.equal(BYID[r.ids[0]].tier, 'free', q.id);
    // Labels follow the teacher's language
    const title = await page.locator('#ll-assistant .ll-title').innerText();
    assert.equal(title, q.lang === 'zh' ? '課堂遊戲小助手' : 'Lesson game finder', q.id);
    // Free/paid label comes from the catalogue tier
    const firstTag = await r.el.locator('.ll-card .ll-tag').first().innerText();
    const tier = BYID[r.ids[0]].tier;
    assert.ok(q.lang === 'zh'
      ? { free: '免費', parent: '付費 · Parent plan', teacher: '付費 · Teacher plan' }[tier] === firstTag
      : { free: 'Free', parent: 'Paid · Parent plan', teacher: 'Paid · Teacher plan' }[tier] === firstTag, `${q.id}: tag ${firstTag}`);
  }

  // Game link click is counted, with no teacher text attached
  const popup = page.waitForEvent('popup');
  await page.locator('#ll-assistant a[data-id]').last().click();
  await (await popup).close();
  const calls = await page.evaluate(() => window.__events);
  assert.ok(calls.some((c) => c[1] === 'll_game_click'));
  assert.ok(calls.some((c) => c[1] === 'll_fallback_shown'));
  for (const c of calls) assert.deepEqual(c[2], { event_category: 'll_assistant' }, 'analytics payload must be anonymous');

  // Email gate: widget hides while it is visible
  await page.locator('#ll-assistant .ll-close').click();
  await page.locator('#gate').click();
  await page.waitForFunction(() => document.getElementById('ll-assistant').hidden);
  await page.locator('#gate-close').click();
  await page.waitForFunction(() => !document.getElementById('ll-assistant').hidden);

  assert.ok(!requests.some((u) => /ll-worker\.js|web-llm\.js|huggingface|githubusercontent/.test(u)), 'no model code or weights requested');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Browser without navigator.gpu at all (older Safari / Firefox) gets the fallback', async () => {
  const { context, page } = await newPage({ noGpuObject: true });
  await openWidget(page);
  assert.equal(await page.evaluate(() => 'gpu' in navigator), false);
  const st = await page.evaluate(() => LLAssistant.internals.state());
  assert.equal(st.ai, 'rules');
  assert.equal(st.device.reason, 'no-webgpu');
  const r = await ask(page, 'Adult, B2, IELTS speaking');
  assert.ok(r.ids.includes('speaking_IeltsSpeakingRoom'));
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
    const st = await page.evaluate(() => LLAssistant.internals.state());
    assert.equal(st.ai, 'rules', name);
    assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false, name);
    const r = await ask(page, 'Age 6 phonics');
    assert.ok(r.ids.length > 0, name);
    await context.close();
  }
});

test('Capable device: size shown, nothing downloads before the click, failed download falls back and keeps the draft', async () => {
  const { context, page, requests } = await newPage({ fakeGpu: true });
  await openWidget(page);
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  const btn = page.locator('#ll-assistant .ll-offer .ll-btn-primary');
  const label = await btn.innerText();
  assert.match(label, /^Download AI · \d+ MB · one-time download$/);
  assert.ok(Number(label.match(/(\d+) MB/)[1]) >= 280, label);
  assert.ok((await events(page)).includes('ll_ai_offered'));
  await page.waitForTimeout(300);
  assert.ok(!requests.some((u) => /ll-worker\.js|web-llm\.js|params_shard|mlc-chat-config/.test(u)), 'downloaded before the click');

  // Real worker + real WebLLM, but the GPU is off and the model host is blocked: load must fail.
  await page.locator('#ll-assistant .ll-input').fill('Age 7, phonics, 30 min');
  await btn.click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'failed', null, { timeout: 30000 });
  assert.ok(requests.some((u) => u.endsWith('/ll-worker.js')));
  assert.ok(requests.some((u) => u.endsWith('/vendor/web-llm.js')));
  assert.equal(await page.locator('#ll-assistant .ll-input').inputValue(), 'Age 7, phonics, 30 min', 'draft kept');
  assert.match(await page.locator('#ll-assistant .ll-notice').innerText(), /Matches by keyword/);
  const ev = await events(page);
  assert.ok(ev.includes('ll_download_started') && ev.includes('ll_fallback_shown'));
  assert.ok(!ev.includes('ll_download_finished'));
  const r = await ask(page, 'Age 7, phonics, 30 min');
  assert.equal(r.source, 'rules');
  assert.ok(r.ids.length > 0);
  await context.close();
});

test('Download shows progress and can be cancelled', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: SLOW_WORKER });
  await openWidget(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn-primary').click();
  await page.waitForFunction(() => /Downloading AI · [1-9]\d?% · \d+ of \d+ MB/.test(document.querySelector('#ll-assistant .ll-progress-text')?.textContent || ''));
  const width = await page.locator('#ll-assistant .ll-bar span').evaluate((s) => parseFloat(s.style.width));
  assert.ok(width > 0);
  await page.locator('#ll-assistant .ll-offer button', { hasText: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'offer');
  assert.equal(await page.locator('#ll-assistant .ll-offer .ll-btn-primary').isVisible(), true);
  await context.close();
});

test('AI path: only catalogue ids render, bad output falls back, ask works, crash mid-session falls back', async () => {
  const { context, page, errors } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await openWidget(page);
  await page.locator('#ll-assistant .ll-offer .ll-btn-primary').click();
  await page.waitForFunction(() => LLAssistant.internals.state().ai === 'ready');
  assert.match(await page.locator('#ll-assistant .ll-notice').innerText(), /^AI running on this device\. It can be wrong\. Nothing you type leaves your device\.$/);
  assert.ok((await events(page)).includes('ll_download_finished'));

  let r = await ask(page, 'Age 7, phonics, 30 min');
  assert.equal(r.source, 'ai');
  assert.equal(r.ids.length, 1, 'fake id and URL discarded');
  for (const h of r.hrefs) assert.ok(REAL_URLS.has(h));
  assert.ok(!r.text.includes('evil.example'));

  r = await ask(page, 'Age 7 phonics BAD');
  assert.equal(r.source, 'rules');
  assert.ok(r.ids.length > 0);
  assert.ok(!r.text.includes('evil.example'));

  r = await ask(page, 'phonics ASK');
  assert.match(r.text, /How old are they\?/);
  await r.el.locator('.ll-chip', { hasText: '7-9' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ll-assistant .ll-you').length === 4);
  await page.waitForFunction(() => !document.querySelector('#ll-assistant .ll-thinking'));
  assert.match(await page.locator('#ll-assistant .ll-you').last().innerText(), /7-9/);
  const after = page.locator('#ll-assistant .ll-bot:not(.ll-thinking)').last();
  assert.ok((await after.locator('a[data-id]').count()) > 0, 'answer after the question');

  r = await ask(page, 'Age 7 phonics CRASH');
  assert.equal(r.source, 'rules', 'crash answered by rules');
  assert.ok(r.ids.length > 0);
  assert.equal(await page.evaluate(() => LLAssistant.internals.state().ai), 'failed');
  assert.match(await page.locator('#ll-assistant .ll-notice').innerText(), /Matches by keyword/);
  r = await ask(page, 'Age 9, grammar, tenses');
  assert.equal(r.source, 'rules');
  assert.ok(!errors.some((e) => !/GPU device lost/.test(e)), errors.join('\n'));
  await context.close();
});

test('Second visit: a fully cached model starts without a download click or download event', async () => {
  const { context, page } = await newPage({ fakeGpu: true, worker: FAKE_WORKER });
  await page.goto(DEMO);
  await page.waitForFunction(() => window.LLAssistant);
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8')).model;
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
  const ev = await events(page);
  assert.ok(!ev.includes('ll_download_started'));
  assert.equal(await page.locator('#ll-assistant .ll-offer').isVisible(), false);
  await context.close();
});
