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
const { checkQuestion } = require(path.join(ROOT, 'tests', 'check.js'));
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const compactRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(JSON.stringify(compactRaw)));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
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
    for (const [a, b] of [['title', 'title'], ['url', 'url'], ['tier', 'tier'], ['mode', 'mode'], ['desc_en', 'description_en'], ['desc_zh', 'description_zh']]) assert.equal(c[a], s[b], `${s.id} ${a}`);
  }
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
  test(`keyword mode: ${q.id}`, () => {
    if (q.expect === 'nothing-sent') { assert.equal(q.text.trim(), ''); return; }
    const r = core.recommendRules(cat, q.text);
    assert.equal(core.detectLang(q.text), q.lang);
    const c = checkQuestion(q, r, cat);
    assert.ok(c.ok, `${q.id}: ${c.fails.join('; ')} -> ${r.kind} ${r.ids.join(', ')}`);
    for (const id of r.ids) assert.ok(realIds.has(id), id);
  });
}

// ---------- AI mode post-processing with scripted models ----------

const reply = (fn) => ({ calls: [], chat(messages, schema) { this.calls.push({ messages, schema }); return Promise.resolve({ text: fn(messages, schema), ms: 1 }); } });
const enumOf = (schema) => (schema.properties || schema.anyOf[0].properties).picks.items.enum;

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
  assert.equal(schema.properties.picks.minItems, 2);
  assert.equal(schema.properties.picks.maxItems, 3);
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
  assert.equal(core.T.en.modeRules, 'Matches by keyword.');
  assert.equal(core.T.zh.modeRules, '按關鍵字配對。');
  assert.ok(!/\bAI\b/.test(core.T.en.modeRules) && !/AI/.test(core.T.zh.modeRules), 'no AI wording in keyword mode');
  assert.deepEqual(core.T.en.tier, { free: 'Free', parent: 'Parent', teacher: 'Teacher' });
  assert.deepEqual(core.T.zh.tier, { free: '免費', parent: '家長版', teacher: '老師版' });
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
  assert.ok(refs.length > 20);
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
  assert.match(css, /\.ll-cta \{[^}]*min-height: 48px;[^}]*font-weight: 700; font-size: 16px;[^}]*border: 3px solid var\(--ll-ink\);[^}]*background: var\(--ll-grad-cta\); color: var\(--ll-ink\)/);
});
