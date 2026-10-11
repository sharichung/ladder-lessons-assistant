// Logic tests, no browser. Run: node tests/unit.test.mjs (after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { core } = require(path.join(ROOT, 'src', 'll-assistant.js'));
const { checkQuestion, runQuestion } = require(path.join(ROOT, 'tests', 'check.js'));
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const compactRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(JSON.stringify(compactRaw)));
const { questions, pairs } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const realIds = new Set(source.games.map((g) => g.id));

function readCsv(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- data ----------

test('compact catalogue matches catalogue.json exactly (nothing added, renamed or invented)', () => {
  assert.equal(cat.games.length, source.games.length);
  for (const s of source.games) {
    const c = cat.byId[s.id];
    assert.ok(c, `missing ${s.id}`);
    for (const [a, b] of [['title', 'title'], ['path', 'path'], ['tier', 'tier'], ['mode', 'mode'], ['desc_en', 'description_en'], ['desc_zh', 'description_zh']]) assert.equal(c[a], s[b], `${s.id} ${a}`);
    assert.equal(!!c.pub, s.in_public_build === true, `${s.id} public`);
  }
});

test('the widget gets no absolute game address: games open by path from the current site', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8');
  assert.doesNotMatch(raw, /ladderlessons\.com/);
  assert.ok(compactRaw.games.every((g) => !('url' in g) && /^\/[^/]/.test(g.path)));
  assert.deepEqual(compactRaw.games.filter((g) => g.pub).map((g) => g.tier), ['free', 'free', 'free', 'free']);
  const js = fs.readFileSync(path.join(ROOT, 'src', 'll-assistant.js'), 'utf8');
  assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /ladderlessons\.com/, 'no site address in the widget code');
});

test('ages.csv is merged by id exactly: blank stays blank, nothing guessed (A1)', () => {
  const rows = readCsv('ages.csv');
  assert.equal(rows.length, source.games.length);
  for (const r of rows) {
    const g = compactRaw.games.find((x) => x.id === r.id);
    assert.ok(g, r.id);
    assert.equal(g.age_min ?? '', r.age_min === '' ? '' : Number(r.age_min), `${r.id} age_min`);
    assert.equal(g.age_max ?? '', r.age_max === '' ? '' : Number(r.age_max), `${r.id} age_max`);
    assert.equal(g.level_min ?? '', r.level_min, `${r.id} level_min`);
    assert.equal(g.level_max ?? '', r.level_max, `${r.id} level_max`);
    assert.equal(!!g.kid, r.kid_theme === 'Y', `${r.id} kid_theme`);
  }
  assert.equal(compactRaw.games.find((g) => g.id === 'speaking_LadderTalk').age_min, 10, 'Ladder Talk age_min set to 10 by the owner');
});

test('age_max is never used: changing it changes no result (A2)', () => {
  const altered = core.prepareCatalogue(JSON.parse(JSON.stringify(compactRaw)));
  altered.games.forEach((g) => { g.age_max = 1; });
  for (const q of questions) {
    assert.deepEqual(core.recommendRules(altered, q.text).ids, core.recommendRules(cat, q.text).ids, q.id);
  }
});

// ---------- parsing (A3, A4) ----------

test('ages parse to number ranges with the Hong Kong mapping', () => {
  const cases = {
    'Primary 5 student vocabulary': [10, 11], 'Primary5 vocabulary': [10, 11], 'P5 vocabulary': [10, 11], 'P 5 vocabulary': [10, 11], 'P.5 vocabulary': [10, 11],
    '小五學生': [10, 11], '小 五 學生': [10, 11], '小5': [10, 11], 'P1': [6, 7], 'P6': [11, 12],
    'Form 4': [15, 16], 'Form4': [15, 16], 'F4': [15, 16], 'F.4': [15, 16], 'F 4': [15, 16], 'S4': [15, 16], 'S.4': [15, 16],
    'Secondary 4': [15, 16], 'Secondary4': [15, 16], '中四': [15, 16], '中 四': [15, 16], '中4': [15, 16], 'F1': [12, 13], 'F6': [17, 18],
    'K1': [3, 4], 'K3': [5, 6], 'DSE': [15, 18], 'HKDSE writing': [15, 18],
    '8 year old': [8, 8], '8-year-old': [8, 8], '8yo': [8, 8], '8歲': [8, 8], 'age 8': [8, 8], 'aged 7-9': [7, 9], '7–9 歲': [7, 9],
    'Age 4–7': [4, 7], 'Age 16+': [16, 150], '16 歲以上': [16, 150],
    'Year 3': [8, 9], 'Grade 3': [9, 10],
  };
  for (const [text, want] of Object.entries(cases)) {
    const a = core.parseQuery(text).age;
    assert.ok(a && a.exact, `${text}: no exact age`);
    assert.deepEqual([a.min, a.max], want, text);
  }
});

test('age words count only without an exact age, and use the oldest age for the filter (1A)', () => {
  assert.deepEqual(core.parseQuery('kids aged 8').age, { min: 8, max: 8, exact: true });
  const kids = core.parseQuery('kids').age;
  assert.deepEqual([kids.min, kids.max, kids.exact], [4, 12, false]);
  assert.equal(core.filterAge(core.parseQuery('kids')), 12);
  assert.equal(core.filterAge(core.parseQuery('Form 4')), 15, 'exact grade uses the youngest age');
  assert.deepEqual([core.parseQuery('adult').age.min, core.parseQuery('adult').age.max], [18, 150]);
});

test('grade patterns do not fire on ordinary words', () => {
  assert.deepEqual(core.parseQuery("There's 3 kids in the group").age, { min: 4, max: 12, exact: false }, "'s 3 is not S3");
  assert.equal(core.parseQuery('其中一個學生想練口語').age, null, '其中一 is not 中一');
  assert.equal(core.parseQuery('其中4個學生').age, null);
  assert.equal(core.parseQuery('P3 writing, sentence form').adultSignal, false, 'bare "form" is not Form N');
  assert.equal(core.parseQuery('writing games to work on sentences').adultSignal, false, '"work on" is not work English');
  assert.equal(core.parseQuery('30 min lesson').age, null, 'lesson length is not an age');
});

test('levels, lesson length and skills', () => {
  assert.deepEqual(core.parseQuery('B2').levels, ['B2']);
  assert.deepEqual(core.parseQuery('C2').levels, ['C2']);
  assert.deepEqual(core.parseQuery('total beginner').levels, ['pre-A1', 'A1']);
  assert.deepEqual(core.parseQuery('pre-intermediate').levels, ['A2']);
  assert.equal(core.parseQuery('45-minute lesson').minutes, 45);
  assert.equal(core.parseQuery('堂課 30 分鐘').minutes, 30);
  assert.equal(core.parseQuery('1 hour').minutes, 60);
  assert.deepEqual(core.lengthRange(20), { min: 1, max: 2 });
  assert.deepEqual(core.lengthRange(30), { min: 2, max: 3 });
  assert.deepEqual(core.lengthRange(null), { min: 1, max: 3 });
  assert.equal(core.parseQuery('9 year old reading').skills.length, 0, 'reading is not phonics');
  assert.ok(core.parseQuery('成人商業英文').skills.includes('finance'));
});

test('teen and adult signals, with the under-13 exception for business and work', () => {
  for (const t of ['teen', 'secondary', 'Form 4', 'F.4', '中四', 'adult', '成人', 'DSE', 'IELTS', 'business english', 'English for work', '15 year old'])
    assert.equal(core.parseQuery(t).adultSignal, true, t);
  for (const t of ['9 year old business game', 'kids business', '10歲 商業', 'P5 money', 'Age 8 phonics'])
    assert.equal(core.parseQuery(t).adultSignal, false, t);
});

// ---------- the fixed questions, keyword mode ----------

for (const q of questions) {
  test(`keyword mode: ${q.id}`, async () => {
    if (q.expect === 'nothing-sent') { assert.equal(q.text.trim(), ''); return; }
    const { res: r, shown } = await runQuestion(core, q, (text, opts) => core.recommendRules(cat, text, opts), cat);
    assert.equal(core.detectLang(q.text), q.lang);
    const c = checkQuestion(q, r, cat, shown);
    assert.ok(c.ok, `${q.id}: ${c.fails.join('; ')} -> ${r.kind} ${r.ids.join(', ')}`);
    for (const id of r.ids) assert.ok(realIds.has(id), id);
  });
}

// C5: a question and its translation get the same games in the same order.
test('keyword mode: questions marked sameAs show the same games in the same order', async () => {
  const run = async (q) => (await runQuestion(core, q, (text, opts) => core.recommendRules(cat, text, opts))).res;
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const marked = questions.filter((q) => q.sameAs);
  assert.ok(marked.length >= 2);
  for (const q of marked) {
    const a = await run(q), b = await run(byId[q.sameAs]);
    assert.equal(a.kind, b.kind, q.id);
    assert.deepEqual(a.ids, b.ids, `${q.text} -> ${a.ids.join(', ')} | ${byId[q.sameAs].text} -> ${b.ids.join(', ')}`);
  }
});

test('keyword mode: English and Chinese question pairs (at least 10) give the same games in the same order (C5)', () => {
  assert.ok(pairs.length >= 10, 'at least 10 pairs');
  for (const [en, zh] of pairs) {
    assert.equal(core.detectLang(en), 'en', en);
    assert.equal(core.detectLang(zh), 'zh', zh);
    const a = core.recommendRules(cat, en), b = core.recommendRules(cat, zh);
    assert.equal(a.kind, 'picks', en);
    assert.equal(b.kind, 'picks', zh);
    assert.deepEqual(a.ids, b.ids, `${en} -> ${a.ids.join(', ')} | ${zh} -> ${b.ids.join(', ')}`);
  }
});

// C5: a word group means one skill in both languages (spelling = 拼寫 = 默書 are all vocabulary).
test('every word group gives the same skills in English and Chinese (C5)', () => {
  const W = core.SKILL_WORDS;
  const skillsOf = (w, lang) => Object.keys(W).filter((id) => W[id][lang].split(' ').includes(w)).sort().join();
  const bad = [];
  for (const [group, en, zh] of core.CONCEPTS) {
    const e = new Set(en.split(' ').map((w) => skillsOf(w, 'en')).filter(Boolean));
    const z = new Set(zh.split(' ').map((w) => skillsOf(w, 'zh')).filter(Boolean));
    if (!e.size && !z.size) continue;
    const all = new Set([...e, ...z]);
    if (all.size > 1 || !e.size || !z.size) bad.push(`${group}: en ${[...e].join('|') || '-'} / zh ${[...z].join('|') || '-'}`);
  }
  assert.deepEqual(bad, []);
});

// C3: every festival a festival game names in English has a Chinese word, and that word finds the game.
test('every festival named by a festival game has a Chinese keyword that finds it (C3)', () => {
  const NAMES = ['christmas', 'xmas', 'halloween', 'easter', 'mid-autumn', 'mooncake', 'chinese new year', 'lunar new year', 'new year',
    'bonfire night', 'dragon boat', 'valentine', 'thanksgiving', 'diwali', 'ching ming', 'chung yeung', 'hanukkah', 'ramadan', 'eid', 'lantern festival'];
  const festivalGames = cat.games.filter((g) => /\bfestival/i.test(g.kw + ' ' + g.title));
  assert.ok(festivalGames.length >= 2);
  let checked = 0;
  for (const g of festivalGames) {
    const text = (g.kw + ' ' + g.desc_en + ' ' + g.title).toLowerCase();
    for (const name of NAMES) {
      if (!new RegExp('\\b' + name.replace(/[- ]/g, '[\\s-]') + '\\b').test(text)) continue;
      checked++;
      const group = name.includes('new year') ? core.CONCEPTS.find((c) => c[0] === 'newyear') : core.CONCEPTS.find((c) => c[1].split(' ').includes(name.split(' ')[0]));
      assert.ok(group, `${g.id}: no word group for "${name}"`);
      const zhWords = group[2].split(' ').filter(Boolean);
      assert.ok(zhWords.length, `${g.id}: "${name}" has no Chinese keyword`);
      for (const w of zhWords) {
        const r = core.recommendRules(cat, w + ' 小朋友');
        assert.ok(r.ids.includes(g.id), `${g.id} "${name}" -> ${w}: ${r.kind} ${r.ids.join(', ')}`);
      }
    }
  }
  assert.ok(checked >= 4, 'festival names found: ' + checked);
  for (const w of ['聖誕', '聖誕節', '萬聖節', '新年', '中秋', '節日', '復活節', '農曆新年']) {
    assert.equal(core.recommendRules(cat, w + ' 活動').ids[0], 'speaking_LadderFestivals', w);
  }
});

test('C4: a message naming several skills gets one game per skill before a second of any', () => {
  const r = core.recommendRules(cat, 'Form 2學生想練tenses、生字跟文章改錯');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].id, 'grammar_TenseStudio', 'message order: tenses first');
  assert.ok(r.items[1].family === 'Ladder Vocabulary' || cat.byId[r.items[1].id || r.items[1].ids[0]].skill === 'vocab', 'then a vocabulary game');
  assert.ok(['grammar_Detective', 'grammar_SentenceSurgery'].includes(r.items[2].id), 'then a proofreading game');
  // One skill named twice ("面試" and "口語") is one request, not two.
  assert.equal(core.facetsOf('小六學生，準備升中面試，練口語').length, 1);
  assert.equal(core.facetsOf('Age 9, speaking and listening').length, 2);
  assert.equal(core.facetsOf('Age 7, beginner, phonics, 30 min').length, 1);
  // AI mode keeps every skill's game.
  assert.deepEqual(r.ctx.lead, r.ctx.facetIds);
});

test('C6: thanks, ok, 多謝 and 唔該 are small talk; with a number or a request they are not', () => {
  for (const t of ['thanks', 'Thanks!', 'ok', 'OK thanks', 'Great, thanks!', 'No more, thanks', 'thank you so much', '多謝', '多謝晒', '唔該', '唔該晒', '好的', '收到'])
    assert.ok(core.smallTalk(t), t);
  for (const t of ['thanks, age 8 phonics', '8 thanks', '九歲 多謝', 'ok another one', '好玩嘅遊戲', 'hello', 'good morning', 'not ok', 'Age 8'])
    assert.equal(core.smallTalk(t), null, t);
  // After "Which skill do you want to practise?", thanks does not answer it: the question stays open.
  const state = { pending: core.pendingFrom(core.recommendRules(cat, 'Age 8'), 'Age 8', 'en'), lastQuery: 'Age 8', shown: [], lang: 'en' };
  assert.equal(state.pending.type, 'skill');
  assert.ok(core.route(state, 'thanks').smalltalk);
  assert.equal(core.route(state, 'phonics').text, 'Age 8. phonics');
});

// ---------- download size: one number everywhere (fix 2) ----------

test('the download size is one measured constant: 289,982,565 bytes = 277 MB, on the button and in the README', () => {
  assert.equal(compactRaw.model.bytes, 289982565, 'scripts/build.mjs MODEL_BYTES is the measured download');
  const mb = core.T && Math.ceil(compactRaw.model.bytes / 1048576);
  assert.equal(mb, 277);
  const { internals } = require(path.join(ROOT, 'src', 'll-assistant.js'));
  assert.equal(internals.toMB(compactRaw.model.bytes), 277);
  assert.equal(core.T.en.offerBtn.replace('{mb}', internals.toMB(compactRaw.model.bytes)), 'Download AI · 277 MB · one-time download');
  assert.equal(core.T.en.offerAgain.replace('{mb}', internals.toMB(compactRaw.model.bytes)), 'Use on-device AI (277 MB)');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'll-assistant.js'), 'utf8');
  assert.doesNotMatch(js, /modelDownloadBytes|headSize|ll-ai-bytes/, 'no second way of working out the size');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const sizes = [...readme.matchAll(/(\d{3}) MB[^\n]*?(?:download|button|offer)|(?:download|button|offer)[^\n.]*?\b(\d{3}) MB/gi)].map((m) => Number(m[1] || m[2]));
  assert.ok(sizes.length > 0 && sizes.every((n) => n === 277), 'README download sizes: ' + sizes.join(', '));
});

// ---------- lesson plan (Feature 1) ----------

const it = (id) => ({ id });
const ids = (plan) => (plan.kind === 'single' ? [plan.item] : plan.steps.map((st) => st.item)).map((x) => x.id || x.family);
// Games without parts, by plan: free, parent and teacher.
const NOPARTS = cat.games.filter((g) => !g.parts);
const FREE0 = NOPARTS.find((g) => g.tier === 'free').id;
const PARENT0 = NOPARTS.filter((g) => g.tier === 'parent').map((g) => g.id);
const TEACHER0 = NOPARTS.filter((g) => g.tier === 'teacher').map((g) => g.id);

// A keyword answer with chosen scores, the way buildPlan gets one.
function fakeAnswer(list, scores, minutes, q = {}) {
  const res = { kind: 'picks', items: list.map(it), q: { minutes, adultSignal: false, ...q }, kidNote: false };
  Object.defineProperty(res, 'ctx', { value: { scoreOf: Object.fromEntries(list.map((id, i) => [id, { s: scores[i] }])) } });
  return res;
}

test('1B: more than four parts become three steps and a fourth joined with " + ", in order, no name dropped', () => {
  assert.deepEqual(core.partSteps(['Warm-up', 'Words', 'Discuss', 'Practice', 'Real Life']), ['Warm-up', 'Words', 'Discuss', 'Practice + Real Life']);
  assert.deepEqual(core.partSteps(['Slides', 'Build', 'Choose', 'Reason', 'Speaking', 'Rapid']), ['Slides', 'Build', 'Choose', 'Reason + Speaking + Rapid']);
  assert.deepEqual(core.partSteps(['A', 'B', 'C', 'D']), ['A', 'B', 'C', 'D']);
  const many = cat.games.filter((g) => g.parts && g.parts.length > 4);
  assert.ok(many.length >= 10, 'games with more than four parts: ' + many.length);
  for (const g of cat.games.filter((x) => x.parts)) {
    for (const total of [null, 5, 10, 15, 20, 30, 45, 60, 90]) {
      const steps = core.partMinutes(total, g.parts).names;
      assert.ok(steps.length <= 4, g.id);
      assert.deepEqual(steps.join(' + ').split(' + '), g.parts, `${g.id} ${total}: every part, in order`);
    }
  }
});

test('ages.csv parts are merged in order, blank stays blank, parts_basis is not used', () => {
  const rows = readCsv('ages.csv');
  for (const r of rows) {
    const g = compactRaw.games.find((x) => x.id === r.id);
    if (!r.parts) assert.equal(g.parts, undefined, r.id);
    else assert.deepEqual(g.parts, r.parts.split(' | '), r.id);
  }
  assert.ok(!JSON.stringify(compactRaw).includes('parts_basis') && !JSON.stringify(compactRaw).includes('screen labels'));
  assert.equal(compactRaw.games.find((g) => g.id === 'grammar_Detective').age_min, 10);
});

test('multi-game plan: step order and minutes for 3 games/30 min, 2 games/25 min, 3 games/no length, 1 game', () => {
  const [p1, p2] = PARENT0;
  // 3 games, 30 min: Main = highest score; warm-up = the free game; wrap-up = the one left. 20/60/20 -> 5/20/5.
  let plan = core.buildPlan(fakeAnswer([FREE0, p1, p2], [6, 9, 7], 30), cat);
  assert.equal(plan.kind, 'multi');
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id, st.min]), [['warmup', FREE0, 5], ['main', p1, 20], ['wrapup', p2, 5]]);
  // 2 games, 25 min: 30/70 -> 5/20 (halves round down; the main activity takes the rest).
  plan = core.buildPlan(fakeAnswer([p1, p2], [5, 9], 25), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id, st.min]), [['warmup', p1, 5], ['main', p2, 20]]);
  // 3 games, no length: labels, no minutes. No free game: warm-up is the next highest.
  plan = core.buildPlan(fakeAnswer([p1, p2, PARENT0[2]], [7, 9, 8], null), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id, st.min]), [['warmup', PARENT0[2], null], ['main', p2, null], ['wrapup', p1, null]]);
  // 1 game: no label; minutes only with a length.
  plan = core.buildPlan(fakeAnswer([p1], [9], null), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id, st.min]), [[null, p1, null]]);
  plan = core.buildPlan(fakeAnswer([p1], [9], 20), cat);
  assert.deepEqual(plan.steps.map((st) => st.min), [20]);
  // A free game that is Main is not also the warm-up.
  plan = core.buildPlan(fakeAnswer([FREE0, p1, p2], [9, 6, 7], 45), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id, st.min]), [['warmup', p2, 10], ['main', FREE0, 25], ['wrapup', p1, 10]]);
});

test('minutes always add up to the stated length, at least 5 a step, never invented', () => {
  for (let total = 1; total <= 180; total++) {
    for (const n of [1, 2, 3]) {
      const games = PARENT0.slice(0, n);
      const plan = core.buildPlan(fakeAnswer(games, games.map((_, i) => 9 - i), total), cat);
      const mins = plan.steps.map((st) => st.min);
      assert.equal(mins.reduce((a, b) => a + b, 0), total, `${n} games ${total} min: ${mins}`);
      if (total >= 5) assert.ok(mins.every((m) => m >= 5), `${n} games ${total} min: ${mins}`);
      if (total % 5 === 0) assert.ok(mins.every((m) => m % 5 === 0), `${n} games ${total} min: ${mins}`);
      assert.equal(plan.steps.length + plan.others.length, n, 'a game left out of the steps is still shown');
    }
    for (const g of cat.games.filter((x) => x.parts)) {
      const split = core.partMinutes(total, g.parts);
      assert.equal(split.mins.reduce((a, b) => a + b, 0), total, `${g.id} ${total}`);
      if (total >= 5) assert.ok(split.mins.every((m) => m >= 5), `${g.id} ${total}: ${split.mins}`);
    }
  }
  // No length: no minutes anywhere.
  for (const q of questions.filter((x) => x.expect === 'picks' && !x.after)) {
    const r = core.recommendRules(cat, q.text);
    const plan = core.buildPlan(r, cat);
    if (r.q.minutes == null) assert.ok(plan.steps.every((st) => st.min == null), q.id);
    else assert.equal(plan.steps.reduce((a, st) => a + st.min, 0), r.q.minutes, q.id);
  }
});

test('single-game plan: Main with parts is the lesson; parts in order; up to 2 other games, free first', () => {
  const tense = core.buildPlan(core.recommendRules(cat, 'Form 2 tenses 45 minutes'), cat);
  assert.equal(tense.kind, 'single');
  assert.equal(tense.item.id, 'grammar_TenseStudio');
  assert.deepEqual(tense.steps.map((st) => st.name), cat.byId.grammar_TenseStudio.parts);
  assert.deepEqual(tense.steps.map((st) => st.min), [15, 10, 10, 10]);
  assert.ok(tense.others.length <= 2);
  // A game without parts as Main gives a multi-game plan.
  const story = core.buildPlan(core.recommendRules(cat, 'P5 student, writing a story, 45 mins'), cat);
  assert.equal(story.kind, 'multi');
  assert.ok(!cat.byId[story.steps.find((st) => st.role === 'main').item.id].parts);
  assert.deepEqual(story.steps.map((st) => st.min), [10, 25, 10]);
  // Other games that fit: free first.
  const talk = core.buildPlan(fakeAnswer(['speaking_LadderTalk', TEACHER0[0], FREE0], [9, 8, 2], null), cat);
  assert.equal(talk.kind, 'single');
  assert.deepEqual(talk.steps.map((st) => st.name), ['Warm-up', 'Words', 'Discuss', 'Practice + Real Life']);
  assert.deepEqual(talk.others.map((x) => x.id), [FREE0, TEACHER0[0]]);
  // Fewer 5-minute blocks than parts: fewer steps, joined with " + " (3A).
  const short = core.buildPlan(fakeAnswer(['speaking_LadderTalk'], [9], 10), cat);
  assert.deepEqual(short.steps.map((st) => [st.name, st.min]), [['Warm-up', 5], ['Words + Discuss + Practice + Real Life', 5]]);
});

test('kid-themed game is never Main for a teen, adult, exam or business question', () => {
  for (const text of ['adult business english', 'Form 4 speaking', 'Form 4 student speaking', 'adult business english 30 min', 'DSE writing', 'IELTS speaking adult', '中四學生 口說', '成人 商務英文', 'Teenager, B1, keeps mixing up tenses']) {
    const r = core.recommendRules(cat, text);
    const plan = core.buildPlan(r, cat);
    const main = plan.kind === 'single' ? plan.item : plan.steps.find((st) => st.role === 'main' || st.role === null).item;
    assert.ok(!(main.ids || [main.id]).every((id) => cat.byId[id].kid), `${text}: Main is kid-themed (${main.id || main.family})`);
  }
  // Even when the kid-themed game has the highest score.
  const kid = NOPARTS.find((g) => g.kid).id;
  let plan = core.buildPlan(fakeAnswer([kid, PARENT0[0]], [12, 5], null, { adultSignal: true }), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id]), [[null, PARENT0[0]]], 'Main alone; the kid-themed game is not the warm-up');
  assert.deepEqual(plan.others.map((x) => x.id), [kid], 'it stays on screen under "Other games that fit"');
  // A2: a kid-themed game is never the first card shown, warm-up included.
  const kids = NOPARTS.filter((g) => g.kid).map((g) => g.id);
  plan = core.buildPlan(fakeAnswer([PARENT0[0], kids[0], PARENT0[1]], [9, 8, 5], 30, { adultSignal: true }), cat);
  assert.deepEqual(plan.steps.map((st) => [st.role, st.item.id]), [['warmup', PARENT0[1]], ['main', PARENT0[0]], ['wrapup', kids[0]]]);
  // The link keeps that shape (marker "o": one step, then the others).
  const one = core.buildPlan(fakeAnswer([kids[0], PARENT0[0], kids[1]], [12, 5, 4], 30, { adultSignal: true }), cat);
  const back = core.parsePlanCode(core.planCode(one, 'en'), cat);
  assert.match(core.planCode(one, 'en'), /^o30e\./);
  assert.deepEqual(back.steps.map((st) => [st.role, st.item.id, st.min]), [[null, PARENT0[0], 30]]);
  assert.deepEqual(back.others.map((x) => [x.id, x.kid]), [[kids[0], true], [kids[1], true]], 'kid-themed tags come back from the catalogue');
});

test('plan summary counts from the catalogue, in English and Chinese', () => {
  const [p1, p2] = PARENT0, t1 = TEACHER0[0];
  let plan = core.buildPlan(fakeAnswer([FREE0, t1, p1], [5, 9, 7], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['You can run step 1 today, free.', '2 of 3 steps are in the Teacher plan.']);
  assert.deepEqual(core.planSummary(plan, cat, 'zh'), ['第 1 步今日就玩得，免費。', '3 步入面有 2 步喺老師版。']);
  plan = core.buildPlan(fakeAnswer([p1, p2, FREE0], [9, 5, 7], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['You can run step 1 today, free.', '2 of 3 steps are in the Parent plan.']);
  plan = core.buildPlan(fakeAnswer([p1, t1], [5, 9], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['Both steps are in the Teacher plan.']);
  assert.deepEqual(core.planSummary(plan, cat, 'zh'), ['2 步全部喺老師版。']);
  // Every step free: only the first line.
  const frees = NOPARTS.filter((g) => g.tier === 'free').map((g) => g.id).slice(0, 2);
  plan = core.buildPlan(fakeAnswer(frees, [9, 5], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['You can run steps 1 and 2 today, free.']);
  assert.deepEqual(core.planSummary(plan, cat, 'zh'), ['第 1、2 步今日就玩得，免費。']);
  // One paid step of three.
  plan = core.buildPlan(fakeAnswer([frees[0], p1, frees[1]], [9, 5, 7], null), cat);
  assert.equal(core.planSummary(plan, cat, 'en')[1], '1 of 3 steps is in the Parent plan.');
  // Single-game plans.
  plan = core.buildPlan(fakeAnswer(['speaking_LadderTalk'], [9], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['This game is in the Teacher plan.']);
  assert.deepEqual(core.planSummary(plan, cat, 'zh'), ['呢隻遊戲喺老師版。']);
  plan = core.buildPlan(fakeAnswer(['phonics_LadderPhonics'], [9], null), cat);
  assert.deepEqual(core.planSummary(plan, cat, 'en'), ['This game is free.']);
  assert.deepEqual(core.planSummary(plan, cat, 'zh'), ['呢隻遊戲免費。']);
});

test('AI mode: the plan is built in code from the model\'s ids', async () => {
  const r = await core.recommendAI(cat, reply(() => JSON.stringify({ picks: ['writing_DetectivesNotebook', 'writing_ChainStory'] })), 'P5 student, writing a story, 45 mins');
  assert.equal(r.source, 'ai');
  const plan = core.buildPlan(r, cat);
  assert.ok(plan && plan.steps.reduce((a, st) => a + st.min, 0) === 45);
  assert.deepEqual(new Set(ids(plan).concat(plan.others.map((x) => x.id))), new Set(r.ids));
});

// ---------- plan link (Feature 2) ----------

test('plan link: round trip, only ids, length, language and a marker; nothing typed', () => {
  const ORIGIN = 'https://app.example.test';
  const LINK = /^https:\/\/app\.example\.test\/library#llplan=([ms])(\d{0,3})([ez])((?:\.[A-Za-z0-9_]+(?:~[A-Za-z0-9_]+)*)+)$/;
  let n = 0;
  for (const q of questions.filter((x) => x.expect === 'picks' && !x.after)) {
    const r = core.recommendRules(cat, q.text);
    const plan = core.buildPlan(r, cat);
    const link = core.planLink(ORIGIN, plan, q.lang);
    const m = LINK.exec(link);
    assert.ok(m, `${q.id}: ${link}`);
    const parts = m[4].slice(1).split(/[.~]/);
    assert.ok(parts.every((id) => cat.byId[id]), `${q.id}: only game ids`);
    assert.equal(m[2], r.q.minutes == null ? '' : String(r.q.minutes));
    // Nothing the teacher typed: no word of the question that is not part of a game id.
    const words = (q.text.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !Object.keys(cat.byId).some((id) => id.toLowerCase().includes(w)));
    const code = link.split('#llplan=')[1].toLowerCase();
    for (const w of words) assert.ok(!code.includes(w), `${q.id}: "${w}" in the link`);
    assert.doesNotMatch(link, /[^\x21-\x7e]/, `${q.id}: no Chinese or spaces`);
    // Round trip.
    const back = core.parsePlanCode(link.split('#llplan=')[1], cat);
    assert.equal(back.kind, plan.kind, q.id);
    assert.equal(back.minutes, plan.minutes, q.id);
    assert.equal(back.lang, q.lang, q.id);
    assert.deepEqual(ids(back), ids(plan), q.id);
    assert.deepEqual(back.steps.map((st) => [st.role, st.min, st.name]), plan.steps.map((st) => [st.role, st.min, st.name]), q.id);
    assert.deepEqual(back.others.map((x) => x.id || x.family), plan.others.map((x) => x.id || x.family), q.id);
    n++;
  }
  assert.ok(n > 100);
  // A sentence full of words that are not game words.
  const plan = core.buildPlan(core.recommendRules(cat, 'Zebrafish Quokka Wombat age 8 phonics 30 min, my student Mei Ling'), cat);
  const link = core.planLink(ORIGIN, plan, 'en');
  for (const w of ['zebrafish', 'quokka', 'wombat', 'mei', 'ling', 'student']) assert.ok(!link.toLowerCase().includes(w), w);
});

test('plan link: unknown ids are left out; with none left there is no plan', () => {
  assert.equal(core.parsePlanCode('m30e.nope_Game.also_Nope', cat), null);
  assert.equal(core.parsePlanCode('x30e.phonics_LadderPhonics', cat), null, 'bad marker');
  assert.equal(core.parsePlanCode('', cat), null);
  assert.equal(core.parsePlanCode('m30e.<script>.phonics_LadderPhonics', cat).steps.length, 1);
  const p = core.parsePlanCode('m30z.nope_Game.listening_NumberNinja.listening_AnnouncementStation', cat);
  assert.equal(p.lang, 'zh');
  assert.deepEqual(p.steps.map((st) => [st.role, st.item.id, st.min]), [['warmup', 'listening_NumberNinja', 10], ['main', 'listening_AnnouncementStation', 20]]);
  // "s" with a first game that has no parts: shown as a list.
  assert.equal(core.parsePlanCode('se.listening_NumberNinja', cat).kind, 'multi');
  assert.equal(core.parsePlanCode('s45e.grammar_TenseStudio.grammar_Detective', cat).kind, 'single');
});

test('mailto: no recipient, the subject, the link and one line per step with the game title', () => {
  const plan = core.buildPlan(core.recommendRules(cat, 'P5 student, writing a story, 45 mins'), cat);
  const url = core.planLink('https://app.example.test', plan, 'en');
  const mail = core.mailtoLink(cat, plan, url, 'en');
  assert.match(mail, /^mailto:\?subject=/);
  const q = new URLSearchParams(mail.slice('mailto:?'.length));
  assert.equal(q.get('subject'), 'My Ladder Lessons lesson plan');
  const body = q.get('body').split('\n');
  assert.equal(body[0], url);
  assert.deepEqual(body.slice(2), plan.steps.map((st, i) => `${i + 1}. ${core.T.en.roles[st.role]}: ${cat.byId[st.item.id].title} (${st.min} min)`));
  const single = core.buildPlan(core.recommendRules(cat, 'Form 2 tenses 45 minutes'), cat);
  const zh = new URLSearchParams(core.mailtoLink(cat, single, 'u', 'zh').slice('mailto:?'.length));
  assert.equal(zh.get('body').split('\n')[2], '1. Tense Studio: Lessons（15 分鐘）'.replace('（', ' (').replace('）', ')'));
});

test('analytics: the plan events are fixed names in the allowlist', () => {
  const { internals } = require(path.join(ROOT, 'src', 'll-assistant.js'));
  for (const e of ['ll_plan_shown', 'll_plan_send_open', 'll_plan_send_email', 'll_plan_send_copy', 'll_plan_send_share', 'll_plan_opened_from_link']) assert.ok(internals.EVENTS.includes(e), e);
  assert.equal(internals.EVENTS.length, 11);
});

// ---------- AI mode post-processing with scripted models ----------

const reply = (fn) => ({ calls: [], chat(messages, schema) { this.calls.push({ messages, schema }); return Promise.resolve({ text: fn(messages, schema), ms: 1 }); } });
const enumOf = (schema) => (schema.properties || schema.anyOf[0].properties).picks.items.enum;

// The owner's run of tests/model-test.html (2026-10-06) recorded the real model's
// reply to every question that reached it. Replaying them shows what the current
// post-processing does with real model output, without a GPU.
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'model-replies-2026-10-06.json'), 'utf8')).replies;

test('AI: the real model\'s recorded replies pass every fixed question after post-processing', async () => {
  const fails = [];
  let replayed = 0;
  for (const q of questions.filter((x) => x.expect !== 'nothing-sent')) {
    const raw = q.after ? null : recorded[q.text];
    const client = { chat: () => { replayed += raw != null; return Promise.resolve({ text: raw == null ? '{"picks":[]}' : raw, ms: 1 }); } };
    const { res, shown } = await runQuestion(core, q, (text, opts) => core.recommendAI(cat, client, text, opts), cat);
    const c = checkQuestion(q, res, cat, shown);
    if (!c.ok) fails.push(`${q.id}: ${c.fails.join('; ')}`);
    if (res.modelInvalid && raw != null) fails.push(`${q.id}: recorded reply now rejected`);
  }
  assert.deepEqual(fails, []);
  assert.equal(replayed, Object.keys(recorded).length, 'every recorded reply was used');
});

test('AI: the keyword answer\'s lead stays first when the model drops or demotes it', async () => {
  const cases = [
    ['10-year-old, A2, listening practice with numbers', ['listening_DetectiveDictation'], 'listening_NumberNinja'],
    ['Adult beginner, everyday English for going to the doctor', ['life_TellingTheTime'], 'speaking_DoctorVisit'],
    ['adult business english', ['finance_MiniBusinessTycoonSuper', 'speaking_QuickFireFlashcards'], 'speaking_LadderTalk'],
  ];
  for (const [text, picks, first] of cases) {
    const res = await core.recommendAI(cat, reply(() => JSON.stringify({ picks })), text);
    assert.equal(res.source, 'ai', text);
    assert.equal(res.ids[0], first, text);
  }
  // 成人 F1 迷 雅思口語: Quick Fire goes first (free, 3A) and IELTS Speaking Room, the best match, is kept.
  const res = await core.recommendAI(cat, reply(() => JSON.stringify({ picks: ['speaking_LadderTalk', 'speaking_HookLab', 'speaking_QuickFireFlashcards'] })), '成人 F1 迷 雅思口語');
  assert.deepEqual(res.ids.slice(0, 2), ['speaking_QuickFireFlashcards', 'speaking_IeltsSpeakingRoom']);
});

test('fixed questions have unique ids', () => {
  const ids = questions.map((q) => q.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('AI: a free game the model left out goes first (A8)', async () => {
  const client = reply(() => JSON.stringify({ picks: ['phonics_SoundCatcher'] }));
  const r = await core.recommendAI(cat, client, 'Age 7, phonics, 30 min');
  assert.equal(r.source, 'ai');
  assert.equal(r.ids[0], 'phonics_LadderPhonics');
  assert.ok(r.ids.includes('phonics_SoundCatcher'));
});

test('AI: the model cannot reorder away the free game (A8)', async () => {
  const client = reply(() => JSON.stringify({ picks: ['phonics_WordSmash', 'phonics_SoundCatcher', 'phonics_LadderPhonics'] }));
  const r = await core.recommendAI(cat, client, 'Age 7, phonics, 45 min');
  assert.equal(r.ids[0], 'phonics_LadderPhonics');
});

test('AI: 50 minutes gives 2 to 3 games even when the model returns one (A7)', async () => {
  const client = reply((m, s) => JSON.stringify({ picks: [enumOf(s)[0]] }));
  const r = await core.recommendAI(cat, client, 'Teenager, B1, keeps mixing up tenses, 50 min');
  assert.ok(r.items.length >= 2 && r.items.length <= 3, r.ids.join());
  const schema = client.calls[0].schema;
  assert.ok(schema.properties.picks.minItems >= 2);
  assert.equal(schema.properties.picks.maxItems, 3);
});

test('AI: no lesson length gives as many games as keyword mode, even when the model returns one (D2)', async () => {
  for (const text of ['Year 5 口說', 'Year 5 speaking']) {
    const keyword = core.recommendRules(cat, text);
    const r = await core.recommendAI(cat, reply((m, s) => JSON.stringify({ picks: [enumOf(s)[0]] })), text);
    assert.equal(r.source, 'ai');
    assert.equal(r.items.length, keyword.items.length, text);
    assert.equal(r.items.length, 3, text);
  }
});

test('follow-ups: detected only when nothing new is asked (D1)', () => {
  for (const t of ['any other recommendations', 'more', 'another one', 'something else', '還有其他推薦嗎', '仲有冇', '其他', '悶', 'different game please', 'I am bored']) assert.ok(core.isFollowUp(t), t);
  for (const t of ['more speaking', 'other festival games', 'another 8 year old', 'something else for phonics', '其他 拼讀', '8歲', 'pizza recipe']) assert.ok(!core.isFollowUp(t), t);
});

test('follow-ups in AI mode: the model only sees games not shown yet (D1)', async () => {
  const first = core.recommendRules(cat, 'Year 5 speaking');
  const client = reply((m, s) => JSON.stringify({ picks: enumOf(s).slice(0, 2) }));
  const r = await core.recommendAI(cat, client, 'Year 5 speaking', { followUp: true, exclude: first.ids });
  assert.ok(enumOf(client.calls[0].schema).every((id) => !first.ids.includes(id)), 'no shown game among the candidates');
  assert.ok(r.ids.length > 0 && r.ids.every((id) => !first.ids.includes(id)), r.ids.join());
});

test('AI: under 30 minutes caps at 2 games', async () => {
  const client = reply((m, s) => JSON.stringify({ picks: enumOf(s).slice(0, 3) }));
  const r = await core.recommendAI(cat, client, 'Age 8 phonics, 20 min');
  assert.ok(r.items.length <= 2);
});

test('AI: kid-themed picks go below others and never first (A2)', async () => {
  const kidFirst = reply((m, s) => JSON.stringify({ picks: enumOf(s).filter((id) => cat.byId[id].kid).slice(0, 3) }));
  for (const text of ['DSE writing', 'DSE 寫作', 'Form 4 Hong Kong student, speaking', 'adult business english', '成人商業英文']) {
    const r = await core.recommendAI(cat, kidFirst, text);
    assert.ok(!cat.byId[r.ids[0]].kid, `${text}: first is ${r.ids[0]}`);
    assert.notEqual(r.ids[0], 'finance_MiniBusinessTycoonJunior');
    assert.notEqual(r.ids[0], 'finance_MiniBusinessTycoonSuper');
    r.items.forEach((it) => { if ((it.ids || [it.id]).every((id) => cat.byId[id].kid)) assert.ok(it.kid, 'kid tag'); });
  }
});

test('AI: questions, off-topic and "no game for this age" never reach the model', async () => {
  const client = reply(() => { throw new Error('must not be called'); });
  for (const text of ['What is the weather in London?', 'Form 4 student', '中四學生', '9 year old reading', 'reading practice', '5 year old grammar', 'My 8 year old wants a pizza recipe']) {
    const r = await core.recommendAI(cat, client, text);
    assert.equal(r.source, 'rules', text);
  }
  assert.equal(client.calls.length, 0);
});

test('AI: a model question becomes the widget\'s own age question; its text is never kept', async () => {
  const client = reply(() => JSON.stringify({ ask: 'Visit https://evil.example.com 1) yes' }));
  const r = await core.recommendAI(cat, client, 'phonics games');
  assert.equal(r.kind, 'ask');
  assert.equal(r.askType, 'age');
  assert.ok(!JSON.stringify({ items: r.items, kind: r.kind, askType: r.askType }).includes('evil'));
});

test('AI: bad output falls back to keywords; crashes are reported', async () => {
  const fake = (text) => reply(() => text);
  const a = await core.recommendAI(cat, fake('{"picks":["nope","phonics_SoundCatcher"]}'), 'Age 6 phonics');
  assert.equal(a.source, 'ai');
  assert.ok(a.ids.includes('phonics_SoundCatcher') && !a.ids.includes('nope'));
  const b = await core.recommendAI(cat, fake('I think you should try https://evil.example.com'), 'Age 6 phonics');
  assert.equal(b.source, 'rules');
  assert.equal(b.modelInvalid, true);
  await assert.rejects(core.recommendAI(cat, { chat: async () => { throw new Error('device lost'); } }, 'Age 6 phonics'));
});

test('AI: candidates carry age_min, level and kid_theme, never a URL or price', () => {
  const q = core.parseQuery('adult business english');
  const ctx = core.buildContext(cat, q);
  const msgs = core.buildMessages(cat, ctx.scored.slice(0, 12).map((x) => x.g), 'adult business english');
  assert.ok(msgs[0].content.startsWith("You pick Ladder Lessons games for a teacher's next lesson."));
  assert.ok(!/https?:\/\//.test(msgs[0].content));
  const json = JSON.parse(msgs[0].content.split('CANDIDATES: ')[1]);
  assert.ok(json.every((c) => typeof c.age_min === 'number'));
  assert.ok(json.some((c) => c.kid_theme === true));
});

// ---------- model output parsing (unchanged injection handling) ----------

const cands = ['phonics_LadderPhonics', 'phonics_WordSmash', 'phonics_SoundCatcher', 'phonics_SyllableSplitter'];
test('model reply: unknown ids, non-candidates, URLs, prose and broken JSON are rejected', () => {
  assert.deepEqual(core.parseModelReply('{"picks":["fake_game","phonics_WordSmash"]}', cands, cat.byId, false), { kind: 'picks', ids: ['phonics_WordSmash'] });
  assert.equal(core.parseModelReply('{"picks":["grammar_TenseStudio"]}', cands, cat.byId, false).kind, 'invalid');
  for (const raw of ['{"picks":["https://evil.example.com"]}', 'Sure! Try Ladder Phonics at https://evil.example.com', '{"picks": [', '', 'null', '[]', '{"picks":"phonics_WordSmash"}', '{"answer":"phonics_WordSmash"}'])
    assert.equal(core.parseModelReply(raw, cands, cat.byId, true).kind, 'invalid', raw);
  assert.equal(core.parseModelReply('{"ask":"How old?"}', cands, cat.byId, false).kind, 'invalid');
});

test('schema: picks limited to candidate ids and to the lesson length', () => {
  const s = core.responseSchema(cands, false, 2, 3);
  assert.deepEqual(s.properties.picks.items.enum, cands);
  assert.equal(s.properties.picks.minItems, 2);
  assert.equal(s.properties.picks.maxItems, 3);
  assert.ok(core.responseSchema(cands, true).anyOf);
});

// ---------- text rules (D1, D2, D4, C2) ----------

test('privacy lines and plan labels are exactly as approved', () => {
  assert.equal(core.T.en.privacy, 'Runs in your browser. What you type is not sent to us.');
  assert.equal(core.T.zh.privacy, '喺你部機運行。你打嘅內容唔會傳送畀我哋。');
  assert.equal(core.T.en.modeAI, 'AI suggestions can be wrong.');
  assert.equal(core.T.zh.modeAI, 'AI 建議可能有錯。');
  assert.equal(core.T.en.planNote, 'Opens the plan details');
  assert.equal(core.T.zh.planNote, '會開啟方案詳情');
  assert.equal(core.T.en.placeholder, 'Age, level, skill');
  assert.equal(core.T.zh.placeholder, '年齡、程度、技能');
  assert.equal(core.T.en.inputLabel, 'Describe your student');
  assert.equal(core.T.zh.inputLabel, '描述你嘅學生');
  assert.deepEqual(core.T.en.tier, { free: 'Free', parent: 'Parent', teacher: 'Teacher' });
  assert.deepEqual(core.T.zh.tier, { free: '免費', parent: '家長版', teacher: '老師版' });
});

test('skill choice labels use the site\'s skill tag words (口說, not 口語)', () => {
  for (const c of source.categories.filter((c) => core.SIX.includes(c.id))) {
    assert.equal(core.T.zh.skills[c.id], c.zh, c.id);
    assert.equal(core.T.en.skills[c.id], c.en, c.id);
  }
  assert.equal(core.T.zh.skills.speaking, '口說');
  assert.deepEqual(core.parseQuery('8歲 口語').skills, ['speaking'], 'a teacher who types 口語 still means speaking');
});

test('no security or certification wording, and the widget never asks for a name (D4)', () => {
  const all = JSON.stringify(core.T);
  assert.doesNotMatch(all, /secur|certif|encrypt|\bsafe\b|guarantee|安全|認證|加密|保證/i);
  assert.doesNotMatch(all, /\bname\b|名字|姓名|叫咩名/i);
});

// ---------- style tokens (B1-B5) ----------

test('CSS uses only ll-tokens.css colours and token names, with exact fallbacks', () => {
  const tokensCss = fs.readFileSync(path.join(ROOT, 'll-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = {};
  for (const m of tokensCss.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens[m[1]] = m[2].trim();
  const css = fs.readFileSync(path.join(ROOT, 'src', 'll-assistant.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const squash = (s) => s.replace(/\s+/g, '').replace(/"/g, "'");
  // Every var(--token, fallback) that is not the widget's own --ll-* name
  const refs = [...css.matchAll(/var\(--([a-z0-9-]+)\s*,\s*((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)\)/gi)];
  assert.ok(refs.length > 15);
  for (const m of refs) {
    const name = m[1];
    if (name.startsWith('ll-')) continue;
    assert.ok(name in tokens, `--${name} is not in ll-tokens.css`);
    assert.equal(squash(m[2]), squash(tokens[name]), `fallback for --${name}`);
  }
  assert.doesNotMatch(css, /--(brand|accent|ui|state)-|--grad-(hero|win)/, 'style-guide names that the site does not define');
  // No colour literal outside the token fallbacks, except white.
  const outside = css.replace(/var\(--[a-z0-9-]+\s*,\s*(?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*\)/gi, '');
  const literals = (outside.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) || []).filter((c) => !/^#fff(fff)?$/i.test(c));
  assert.deepEqual(literals, [], 'colours not from ll-tokens.css');
  // Secondary text never uses --muted (2.5:1 contrast).
  assert.doesNotMatch(css, /(^|[^-])color:\s*var\(--ll-muted\)/);
  // Every --ll-* used is defined.
  const defined = new Set([...css.matchAll(/(--ll-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const m of css.matchAll(/var\((--ll-[a-z0-9-]+)\)/g)) assert.ok(defined.has(m[1]), `${m[1]} used but not defined`);
});

test('plan label CSS copies the library page .tier rules', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'll-assistant.css'), 'utf8');
  assert.match(css, /\.ll-tier \{[^}]*font-weight: 600; font-size: 11px; letter-spacing: \.04em;[^}]*padding: 3px 10px;[^}]*border: 2px solid var\(--ll-ink\); color: var\(--ll-ink\)/);
  assert.match(css, /\.ll-tier\[data-t="1"\] \{ background: var\(--ll-tier-free\)/);
  assert.match(css, /\.ll-tier\[data-t="2"\] \{ background: var\(--ll-yellow\)/);
  assert.match(css, /\.ll-tier\[data-t="3"\] \{ background: var\(--ll-purple-1\); border-color: var\(--ll-purple-1\)/);
  assert.match(css, /\.ll-cta \{[^}]*min-height: 44px;[^}]*font-weight: 700; font-size: 16px;[^}]*border: 3px solid var\(--ll-ink\);[^}]*background: var\(--ll-grad-cta\); color: var\(--ll-ink\)/);
  // B5: disabled as on the site
  assert.match(css, /\.ll-cta:disabled \{ background: var\(--ll-line\); color: var\(--ll-ink-soft\); border-color: var\(--ll-muted\); box-shadow: none;/);
});

test('colour budget: coral only on the enabled primary button, no coral or red border, ink borders on cards and composer (E1-E3)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'll-assistant.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const CORAL = /--(?:ll-)?(?:coral|coral-dark|coral-ink|coral-pale|grad-cta|error)\b|#ff6b6b|#ff8e53|#c9453f|#e74c3c/i;
  let gradientUses = 0;
  for (const r of rules) {
    for (const decl of r.body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim(), val = decl.slice(i + 1);
      if (/^border(?!-radius)|^outline(?!-offset)/.test(prop)) {
        // E1: borders and outlines are ink (the plan label keeps the library's own colours)
        assert.match(val.trim(), /^(?:0|none|[\d.]+px solid var\(--ll-(?:ink|line)\)|var\(--ll-(?:ink|muted|purple-1)\)|1px solid var\(--ll-line\))$/, `${r.sel} { ${prop}: ${val.trim()} }`);
      }
      if (!CORAL.test(val)) continue;
      if (prop.startsWith('--')) { assert.equal(prop, '--ll-grad-cta'); assert.equal(r.sel, '#ll-assistant'); continue; }
      // E2: only the enabled primary button
      assert.ok(r.sel.split(',').every((x) => /\.ll-cta\b/.test(x) && !/disabled/.test(x)), `${r.sel} uses coral`);
      gradientUses++;
    }
  }
  assert.equal(gradientUses, 1, 'the gradient is set in one rule');
  // E3: result card, composer
  assert.match(css, /\.ll-card \{[^}]*border: 3px solid var\(--ll-ink\); border-radius: var\(--ll-r-md\); box-shadow: var\(--ll-sh-rung\)/);
  assert.match(css, /\.ll-composer \{[^}]*background: #fff; border: 2\.5px solid var\(--ll-ink\); border-radius: var\(--ll-r-md\)/);
  assert.match(css, /\.ll-input \{[^}]*border: 0;/);
  // A5: focus uses :focus-visible and the yellow ring
  assert.doesNotMatch(css.replace(/\.ll-input:focus,|button:focus \{ outline: none; \}/g, ''), /:focus(?![-\w])/);
  assert.match(css, /--ll-ring: 0 0 0 4px var\(--ll-yellow\)/);
});
