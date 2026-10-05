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
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const cat = core.prepareCatalogue(JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'll-assistant', 'catalogue.compact.json'), 'utf8')));
const { questions } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'questions.json'), 'utf8'));
const realUrls = new Set(source.games.map((g) => g.url));
const realIds = new Set(source.games.map((g) => g.id));

test('compact catalogue matches catalogue.json exactly (nothing added, renamed or invented)', () => {
  assert.equal(cat.games.length, source.games.length);
  for (const s of source.games) {
    const c = cat.byId[s.id];
    assert.ok(c, `missing ${s.id}`);
    assert.equal(c.title, s.title);
    assert.equal(c.url, s.url);
    assert.equal(c.tier, s.tier);
    assert.equal(c.mode, s.mode);
    assert.equal(c.desc_en, s.description_en);
  }
});

for (const q of questions) {
  test(`rules: ${q.id}`, () => {
    if (q.expect === 'nothing-sent') { assert.equal(q.text.trim(), ''); return; }
    const r = core.recommendRules(cat, q.text);
    assert.equal(core.detectLang(q.text), q.lang);
    if (q.expect === 'none') { assert.equal(r.kind, 'none'); return; }
    assert.equal(r.kind, 'picks', JSON.stringify(r.q));
    assert.ok(r.ids.length >= 1 && r.ids.length <= 3);
    for (const id of r.ids) {
      assert.ok(realIds.has(id), `unknown id ${id}`);
      assert.ok(realUrls.has(cat.byId[id].url), `link not in catalogue ${id}`);
    }
    assert.ok(r.ids.some((id) => q.anyOf.includes(id)), `${q.id}: got ${r.ids.join(', ')}`);
    if (q.freeFirst) assert.equal(cat.byId[r.ids[0]].tier, 'free', `${q.id}: first pick not free`);
  });
}

test('parseQuery reads age, level, skill and length', () => {
  const p = core.parseQuery('8 year old, A1, phonics, 45-minute lesson');
  assert.deepEqual(p.ages, ['7-9']);
  assert.deepEqual(p.levels, ['A1']);
  assert.ok(p.skills.includes('phonics'));
  assert.equal(p.minutes, 45);
  assert.deepEqual(core.parseQuery('中二學生').ages, ['13-17']);
  assert.deepEqual(core.parseQuery('P5').ages, ['10-12']);
  assert.deepEqual(core.parseQuery('K3 kids').ages, ['4-6']);
  assert.deepEqual(core.parseQuery('adult, IELTS').ages, ['adult']);
  assert.deepEqual(core.parseQuery('7 歲').ages, ['7-9']);
  assert.equal(core.parseQuery('堂課 30 分鐘').minutes, 30);
  assert.equal(core.parseQuery('1 hour').minutes, 60);
  assert.equal(core.parseQuery('phonics please').hasAge, false);
  assert.equal(core.parseQuery('phonics please').hasLevel, false);
});

// ---------- model output handling ----------
const cands = ['phonics_LadderPhonics', 'phonics_WordSmash', 'phonics_SoundCatcher', 'phonics_SyllableSplitter'];

test('model reply: ids not in the catalogue are discarded', () => {
  const r = core.parseModelReply('{"picks":["fake_game","phonics_WordSmash"]}', cands, cat.byId, false);
  assert.deepEqual(r, { kind: 'picks', ids: ['phonics_WordSmash'] });
});

test('model reply: catalogue ids that were not candidates are discarded', () => {
  const r = core.parseModelReply('{"picks":["grammar_TenseStudio"]}', cands, cat.byId, false);
  assert.equal(r.kind, 'invalid');
});

test('model reply: URLs, prose and broken JSON are invalid', () => {
  for (const raw of ['{"picks":["https://evil.example.com"]}', 'Sure! Try Ladder Phonics at https://evil.example.com', '{"picks": [', '', 'null', '[]', '{"picks":"phonics_WordSmash"}', '{"answer":"phonics_WordSmash"}']) {
    assert.equal(core.parseModelReply(raw, cands, cat.byId, true).kind, 'invalid', raw);
  }
});

test('model reply: at most 3 picks, no duplicates, free game moved first', () => {
  const r = core.parseModelReply('{"picks":["phonics_WordSmash","phonics_WordSmash","phonics_SoundCatcher","phonics_SyllableSplitter","phonics_LadderPhonics"]}', cands, cat.byId, false);
  assert.deepEqual(r.ids, ['phonics_WordSmash', 'phonics_SoundCatcher', 'phonics_SyllableSplitter']);
  const f = core.parseModelReply('{"picks":["phonics_WordSmash","phonics_LadderPhonics"]}', cands, cat.byId, false);
  assert.deepEqual(f.ids, ['phonics_LadderPhonics', 'phonics_WordSmash']);
});

test('model reply: ask is accepted only when allowed, and unsafe text is dropped', () => {
  const ok = core.parseModelReply('{"ask":"How old are your students? 1) 4-6 2) 7-9 3) 10-12 4) Adults"}', cands, cat.byId, true);
  assert.equal(ok.kind, 'ask');
  assert.deepEqual(ok.choices, ['4-6', '7-9', '10-12', 'Adults']);
  assert.equal(core.parseModelReply('{"ask":"How old?"}', cands, cat.byId, false).kind, 'invalid');
  for (const bad of ['Visit https://evil.example.com 1) yes', 'All games are free! 1) ok', 'It costs $5 1) ok', 'x'.repeat(300)]) {
    const r = core.parseModelReply(JSON.stringify({ ask: bad }), cands, cat.byId, true);
    assert.equal(r.kind, 'ask');
    assert.equal(r.question, null, bad);
  }
});

test('schema: picks limited to candidate ids; asking only allowed when age and level are unknown', () => {
  const s = core.responseSchema(cands, false);
  assert.deepEqual(s.properties.picks.items.enum, cands);
  assert.equal(s.properties.picks.maxItems, 3);
  assert.ok(core.responseSchema(cands, true).anyOf);
});

test('prompt: only candidates are sent, and the model never sees a URL or price', () => {
  const games = cands.map((id) => cat.byId[id]);
  const msgs = core.buildMessages(cat, games, 'Age 7 phonics');
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].content.startsWith("You pick Ladder Lessons games for a teacher's next lesson."));
  assert.ok(!/https?:\/\//.test(msgs[0].content));
  const json = JSON.parse(msgs[0].content.split('CANDIDATES: ')[1]);
  assert.deepEqual(json.map((c) => c.id), cands);
});

test('recommendAI: bad model output falls back to rules, crashes are reported', async () => {
  const fake = (text) => ({ chat: async () => ({ text, ms: 1 }) });
  const a = await core.recommendAI(cat, fake('{"picks":["nope","phonics_SoundCatcher"]}'), 'Age 6 phonics');
  assert.equal(a.source, 'ai');
  assert.deepEqual(a.ids, ['phonics_SoundCatcher']);
  const b = await core.recommendAI(cat, fake('I think you should try https://evil.example.com'), 'Age 6 phonics');
  assert.equal(b.source, 'rules');
  assert.equal(b.modelInvalid, true);
  assert.ok(b.ids.every((id) => realIds.has(id)));
  const c = await core.recommendAI(cat, fake('{"picks":["phonics_SoundCatcher"]}'), 'What is the weather in London?');
  assert.equal(c.kind, 'none', 'off-topic never reaches the model');
  await assert.rejects(core.recommendAI(cat, { chat: async () => { throw new Error('device lost'); } }, 'Age 6 phonics'));
});
