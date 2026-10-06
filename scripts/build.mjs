// Build the deployable widget folder: dist/ll-assistant/
//
//   node scripts/build.mjs
//
// 1. Reads catalogue.json (the only source of games), ages.csv (age_min,
//    age_max, level_min, level_max, kid_theme) and data/teacher-fields.csv
//    (optional how-to-run lines). Nothing is inferred: a blank stays blank.
// 2. Writes catalogue.compact.json with only the fields the widget needs.
// 3. Copies the widget files and the WebLLM library into the same folder.
//
// The build stops with a list of problems if a required field is missing or a
// CSV value is not one of the allowed values.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'll-assistant');

const LEVELS = ['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const REQUIRED = ['id', 'title', 'url', 'category', 'tier', 'free', 'mode',
  'description_en', 'description_zh', 'keywords'];

// Must match the record in @mlc-ai/web-llm's prebuiltAppConfig. Checked below.
const MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

const problems = [];

// ---------- catalogue ----------
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalogue.json'), 'utf8'));
const categories = Object.fromEntries((source.categories || []).map(c => [c.id, c]));
const seen = new Set();

for (const g of source.games) {
  for (const f of REQUIRED) {
    if (g[f] === undefined || g[f] === null || g[f] === '') problems.push(`${g.id || '(no id)'}: missing "${f}"`);
  }
  if (seen.has(g.id)) problems.push(`${g.id}: duplicate id`);
  seen.add(g.id);
  if (!/^https:\/\/ladderlessons\.com\//.test(g.url || '')) problems.push(`${g.id}: url is not on https://ladderlessons.com/`);
  if (!['free', 'parent', 'teacher'].includes(g.tier)) problems.push(`${g.id}: unknown tier "${g.tier}"`);
  if (g.free !== (g.tier === 'free')) problems.push(`${g.id}: "free" and "tier" disagree`);
  if (!['led', 'solo'].includes(g.mode)) problems.push(`${g.id}: unknown mode "${g.mode}"`);
  if (!categories[g.category]) problems.push(`${g.id}: category "${g.category}" is not in categories`);
}

// ---------- teacher-fields.csv (optional values) ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(c => c.trim() !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

function readCsv(file) {
  return parseCsv(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// ---------- ages.csv (age and level data, one row per game) ----------
// Blank means "no limit". age_max is carried into the compact catalogue but
// the widget never uses it (there is no upper age limit).
const ages = {};
if (!fs.existsSync(path.join(ROOT, 'ages.csv'))) problems.push('ages.csv is missing from the repo root');
else {
  const rows = readCsv('ages.csv');
  for (const col of ['id', 'title', 'tier', 'age_min', 'age_max', 'level_min', 'level_max', 'kid_theme']) {
    if (rows.length && !(col in rows[0])) problems.push(`ages.csv: column "${col}" is missing`);
  }
  const byId = Object.fromEntries(source.games.map(g => [g.id, g]));
  const intOrBlank = (v, id, col) => {
    if (v === '') return null;
    if (!/^\d{1,3}$/.test(v) || Number(v) > 150) { problems.push(`ages.csv ${id}: ${col} "${v}" must be a whole number from 0 to 150, or blank`); return null; }
    return Number(v);
  };
  const levelOrBlank = (v, id, col) => {
    if (v === '') return null;
    const l = LEVELS.find(x => x.toLowerCase() === v.toLowerCase());
    if (!l) { problems.push(`ages.csv ${id}: ${col} "${v}" must be one of ${LEVELS.join(', ')}, or blank`); return null; }
    return l;
  };
  for (const r of rows) {
    const g = byId[r.id];
    if (!g) { problems.push(`ages.csv: id "${r.id}" is not in catalogue.json`); continue; }
    if (ages[r.id]) { problems.push(`ages.csv: id "${r.id}" appears twice`); continue; }
    if (r.title !== g.title) problems.push(`ages.csv ${r.id}: title "${r.title}" differs from catalogue.json "${g.title}"`);
    if (r.tier !== g.tier) problems.push(`ages.csv ${r.id}: tier "${r.tier}" differs from catalogue.json "${g.tier}"`);
    const a = {
      age_min: intOrBlank(r.age_min, r.id, 'age_min'),
      age_max: intOrBlank(r.age_max, r.id, 'age_max'),
      level_min: levelOrBlank(r.level_min, r.id, 'level_min'),
      level_max: levelOrBlank(r.level_max, r.id, 'level_max'),
      kid: r.kid_theme === 'Y',
    };
    if (!['', 'Y'].includes(r.kid_theme)) problems.push(`ages.csv ${r.id}: kid_theme "${r.kid_theme}" must be Y or blank`);
    if (a.age_min != null && a.age_max != null && a.age_min > a.age_max) problems.push(`ages.csv ${r.id}: age_min is above age_max`);
    if (a.level_min && a.level_max && LEVELS.indexOf(a.level_min) > LEVELS.indexOf(a.level_max)) problems.push(`ages.csv ${r.id}: level_min is above level_max`);
    ages[r.id] = a;
  }
  for (const g of source.games) if (!ages[g.id]) problems.push(`ages.csv: no row for "${g.id}"`);
}

// ---------- data/teacher-fields.csv (optional how-to-run lines) ----------
const csvPath = path.join(ROOT, 'data', 'teacher-fields.csv');
const extra = {};
if (fs.existsSync(csvPath)) {
  for (const r of parseCsv(fs.readFileSync(csvPath, 'utf8'))) {
    if (!seen.has(r.id)) { problems.push(`teacher-fields.csv: id "${r.id}" is not in catalogue.json`); continue; }
    if ((r.age_band || r.level)) problems.push(`teacher-fields.csv ${r.id}: age and level now come from ages.csv only`);
    extra[r.id] = { how_en: r.how_to_run_en || null, how_zh: r.how_to_run_zh || null };
    if (r.how_to_run_zh && !r.how_to_run_en) problems.push(`${r.id}: how_to_run_zh is filled but how_to_run_en is empty`);
  }
}

// ---------- WebLLM model record ----------
const webllmSrc = path.join(ROOT, 'node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js');
if (!fs.existsSync(webllmSrc)) problems.push('node_modules/@mlc-ai/web-llm is missing. Run: npm install');
let modelLib = null, modelUrl = null, vramMB = null;
if (fs.existsSync(webllmSrc)) {
  const js = fs.readFileSync(webllmSrc, 'utf8');
  const prefix = js.match(/const modelLibURLPrefix = "([^"]+)"/)[1];
  const version = js.match(/const modelVersion = "([^"]+)"/)[1];
  const rec = js.match(new RegExp(`model_id: "${MODEL_ID}",\\s*model_lib: modelLibURLPrefix \\+\\s*modelVersion \\+\\s*"([^"]+)"`));
  if (!rec) problems.push(`WebLLM's prebuilt list no longer contains ${MODEL_ID}`);
  else modelLib = prefix + version + rec[1];
  const url = js.match(new RegExp(`model: "([^"]+)",\\s*model_id: "${MODEL_ID}"`));
  if (!url) problems.push(`Could not find the weights URL for ${MODEL_ID}`);
  else modelUrl = url[1].replace(/\/?$/, '/') + 'resolve/main/';
  const vram = js.match(new RegExp(`model_id: "${MODEL_ID}"[\\s\\S]{0,400}?vram_required_MB: ([0-9.]+)`));
  if (vram) vramMB = Number(vram[1]);
}

if (problems.length) {
  console.error(`Build stopped. ${problems.length} problem(s):\n  - ` + problems.join('\n  - '));
  process.exit(1);
}

// ---------- write ----------
const compact = {
  v: 1,
  built: new Date().toISOString().slice(0, 10),
  model: { id: MODEL_ID, url: modelUrl, lib: modelLib, vram_mb: vramMB },
  skills: Object.fromEntries(Object.values(categories).map(c => [c.id, { en: c.en, zh: c.zh }])),
  games: source.games.map(g => {
    const e = extra[g.id] || {};
    const a = ages[g.id] || {};
    const out = {
      id: g.id, title: g.title, url: g.url, skill: g.category,
      tier: g.tier, mode: g.mode,
      desc_en: g.description_en, desc_zh: g.description_zh,
      kw: g.keywords,
    };
    if (a.age_min != null) out.age_min = a.age_min;
    if (a.age_max != null) out.age_max = a.age_max;
    if (a.level_min) out.level_min = a.level_min;
    if (a.level_max) out.level_max = a.level_max;
    if (a.kid) out.kid = true;
    if (e.how_en) out.how_en = e.how_en;
    if (e.how_zh) out.how_zh = e.how_zh;
    return out;
  }),
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'catalogue.compact.json'), JSON.stringify(compact));
for (const f of ['ll-assistant.js', 'll-assistant.css', 'll-worker.js']) {
  fs.copyFileSync(path.join(ROOT, 'src', f), path.join(OUT, f));
}
fs.copyFileSync(webllmSrc, path.join(OUT, 'vendor', 'web-llm.js'));
fs.copyFileSync(path.join(ROOT, 'node_modules', '@mlc-ai', 'web-llm', 'LICENSE'), path.join(OUT, 'vendor', 'web-llm.LICENSE.txt'));

const n = compact.games.length;
const count = k => compact.games.filter(g => g[k]).length;
const kb = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + ' KB';
console.log(`Built dist/ll-assistant/ from ${n} games`);
console.log(`  from ages.csv: age_min ${compact.games.filter(g => g.age_min != null).length}/${n}, levels ${compact.games.filter(g => g.level_min || g.level_max).length}/${n}, kid_theme ${count('kid')}/${n}; how-to-run: ${count('how_en')}/${n}`);
console.log(`  ll-assistant.js ${kb('ll-assistant.js')}, ll-assistant.css ${kb('ll-assistant.css')}, catalogue.compact.json ${kb('catalogue.compact.json')}`);
console.log(`  vendor/web-llm.js ${(fs.statSync(path.join(OUT, 'vendor', 'web-llm.js')).size / 1048576).toFixed(1)} MB (loaded only after the download click)`);
