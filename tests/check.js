// One checker for every fixed question, shared by tests/unit.test.mjs,
// tests/e2e.test.mjs, tests/compare.mjs and tests/model-test.html, so keyword
// mode and AI mode are judged by the same rules.
//
// result: { kind: 'picks'|'ask'|'none', askType, items: [{id} | {family, ids}], q: parsed query (optional) }
// cat:    the prepared compact catalogue (byId), used to look up free and kid_theme.
//
// Question fields (all optional except text and expect):
//   expect      picks | none | smalltalk | ask-skill | ask-age | ask-reading | ask-noGames | ask-more | nothing-sent
//               (ask-more: a follow-up with no game left; it says so and offers skills;
//               smalltalk: "thanks", "ok", 多謝 get a short polite reply, never a question)
//   after       a message sent first, in the same conversation (D1 follow-ups)
//   newOnly     no game shown for the "after" message is shown again
//   anyOf       at least one of these ids is shown
//   first       the first card is this game
//   firstAnyOf  the first card is one of these games
//   eachOf      [[ids], [ids], ...]: every group has a game shown (one game per named skill)
//   eachOfSkills every one of these skills has a game shown
//   skillsFirst the first cards cover these skills, one each, before a second game of any skill
//   sameAs      id of the same question in the other language: same games in the same
//               order (keyword mode only; checked by the runners, not here)
//
// With a lesson plan (res.plan, from core.buildPlan or the widget's turn), firstNotKid
// and freeFirst are also judged on what the teacher sees: the first card shown is
// never kid-themed, and a free game in the picks is the warm-up, Main, or the first
// of "Other games that fit".
//   notFirst    the first card is none of these
//   firstNotKid the first card is not kid-themed
//   noneOf      none of these ids is shown
//   minPicks / maxPicks   number of cards (a Ladder Vocabulary card with several levels counts once)
//   freeFirst   the first card is a free game
//   vocabLevels exactly these Ladder Vocabulary ids are shown, on one card
//   parseAge    [min, max] parsed from the question
//   kidNote     whether the "no game for teens or adults yet" note is shown
//   kidTagged   every kid-themed card carries the Kid-themed tag
//   forbid      strings that must not appear anywhere in the result
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LLCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function idsOf(items) { return (items || []).reduce(function (a, it) { return a.concat(it.ids || [it.id]); }, []); }

  // The cards of a lesson plan in the order shown, as id lists. Takes a plan from
  // core.buildPlan ({id} / {family, ids} items) or from the widget's turns()
  // (arrays of ids).
  function planOrder(plan) {
    var ids = function (x) { return Array.isArray(x) ? x : (x.ids || [x.id]); };
    var main = plan.kind === 'single' ? [ids(plan.item)] : plan.steps.map(function (st) { return ids(st.ids || st.item); });
    return main.concat((plan.others || []).map(ids));
  }
  function firstGame(items) { return items && items.length ? (items[0].ids ? items[0].ids[0] : items[0].id) : null; }

  // Runs a question the way the widget does: the "after" message first, then the
  // question, through core.route (small talk, a follow-up, an answer to the
  // open question, or a new question). recommend(text, opts) returns a result
  // or a promise of one. Older cores without route: follow-ups only.
  function runQuestion(core, q, recommend, cat) {
    return Promise.resolve(q.after ? recommend(q.after) : null).then(function (prev) {
      var shown = prev && prev.kind === 'picks' ? idsOf(prev.items) : [];
      var res;
      var addPlan = function (r) {
        if (cat && core.buildPlan && r && r.kind === 'picks' && !r.plan) { try { r.plan = core.buildPlan(r, cat); } catch (e) { /* older core */ } }
        return r;
      };
      if (core.route) {
        var lang = (core.messageLang && core.messageLang(q.after || '')) || q.lang || 'en';
        var state = {
          pending: prev ? core.pendingFrom(prev, q.after, lang) : null,
          lastQuery: prev && (prev.kind === 'picks' || prev.kind === 'ask') ? q.after : null,
          shown: shown, lang: lang,
        };
        var r = core.route(state, q.text);
        if (r.smalltalk) res = { kind: 'smalltalk', items: [], ids: [], thanks: r.smalltalk.thanks };
        else res = recommend(r.text, Object.assign({ noAsk: r.noAsk }, r.follow || {}));
      } else {
        var follow = core.isFollowUp && core.isFollowUp(q.text);
        res = follow ? recommend(q.after || '', { followUp: true, exclude: shown }) : recommend(q.text);
      }
      return Promise.resolve(res).then(function (r) { return { res: addPlan(r), shown: shown }; });
    });
  }

  function checkQuestion(q, res, cat, shownBefore) {
    var fails = [];
    function fail(msg) { fails.push(msg); }
    var byId = cat.byId;
    var items = res.items || [];
    var ids = idsOf(items);
    var first = firstGame(items);

    // Always: every game shown exists in the catalogue.
    ids.forEach(function (id) { if (!byId[id]) fail('unknown id ' + id); });

    var want = q.expect;
    if (want === 'nothing-sent') return { ok: true, fails: [] };
    if (want === 'picks' && res.kind !== 'picks') fail('expected picks, got ' + res.kind + (res.askType ? ':' + res.askType : ''));
    if (want === 'none' && res.kind !== 'none') fail('expected none, got ' + res.kind);
    if (want === 'smalltalk' && res.kind !== 'smalltalk') fail('expected a short polite reply, got ' + res.kind + (res.askType ? ':' + res.askType : ''));
    if (want === 'ask-more') {
      if (res.kind !== 'ask' || res.askType !== 'skill' || !res.noMore) fail('expected "no more games" with skill choices, got ' + res.kind + (res.askType ? ':' + res.askType : ''));
    } else if (/^ask-/.test(want)) {
      var type = want.slice(4);
      if (res.kind !== 'ask' || res.askType !== type) fail('expected ask ' + type + ', got ' + res.kind + (res.askType ? ':' + res.askType : ''));
    }
    if (q.newOnly && shownBefore) ids.forEach(function (id) { if (shownBefore.indexOf(id) >= 0) fail('shows ' + id + ' again'); });

    if (q.anyOf && !ids.some(function (id) { return q.anyOf.indexOf(id) >= 0; })) fail('none of ' + q.anyOf.join(', ') + ' shown; shows ' + (ids.join(', ') || 'nothing'));
    if (q.first && first !== q.first) fail('first is ' + first + ', expected ' + q.first);
    if (q.firstAnyOf && q.firstAnyOf.indexOf(first) < 0) fail('first is ' + first + ', expected one of ' + q.firstAnyOf.join(', '));
    if (q.eachOf) q.eachOf.forEach(function (group) {
      if (!ids.some(function (id) { return group.indexOf(id) >= 0; })) fail('no game from [' + group.join(', ') + ']; shows ' + (ids.join(', ') || 'nothing'));
    });
    if (q.eachOfSkills) q.eachOfSkills.forEach(function (skill) {
      if (!ids.some(function (id) { return byId[id] && byId[id].skill === skill; })) fail('no ' + skill + ' game; shows ' + (ids.join(', ') || 'nothing'));
    });
    if (q.skillsFirst) {
      var lead = items.slice(0, q.skillsFirst.length).map(function (it) { return byId[(it.ids || [it.id])[0]].skill; });
      if (lead.slice().sort().join() !== q.skillsFirst.slice().sort().join()) fail('first cards are ' + lead.join(', ') + ', expected one each of ' + q.skillsFirst.join(', '));
    }
    if (res.plan && (q.firstNotKid || q.freeFirst)) {
      var order = planOrder(res.plan);
      var kidCard = function (list) { return list.every(function (id) { return byId[id] && byId[id].kid; }); };
      if (q.firstNotKid && order.length && kidCard(order[0])) fail('first card shown is kid-themed: ' + order[0].join('/'));
      if (q.freeFirst) {
        var p = res.plan, nSteps = p.kind === 'single' ? 1 : p.steps.length;
        var leadCards = p.kind === 'single' ? order.slice(0, 1).concat(order.slice(1, 2)) : order.slice(0, Math.min(2, nSteps)).concat(nSteps === 1 ? order.slice(1, 2) : []);
        var free = function (list) { return list.some(function (id) { return byId[id] && byId[id].tier === 'free'; }); };
        if (order.some(free) && !leadCards.some(free)) fail('the free game is not the warm-up, Main or the first other game');
      }
    }
    if (q.notFirst && q.notFirst.indexOf(first) >= 0) fail('first is ' + first + ', which is not allowed first');
    if (q.firstNotKid && first && byId[first] && byId[first].kid) fail('first is kid-themed: ' + first);
    if (q.noneOf) ids.forEach(function (id) { if (q.noneOf.indexOf(id) >= 0) fail('shows ' + id + ', which must not appear'); });
    if (q.minPicks != null && items.length < q.minPicks) fail(items.length + ' cards, expected at least ' + q.minPicks);
    if (q.maxPicks != null && items.length > q.maxPicks) fail(items.length + ' cards, expected at most ' + q.maxPicks);
    if (q.freeFirst && !(first && byId[first] && byId[first].tier === 'free')) fail('first card is not free: ' + first);
    if (q.vocabLevels) {
      var ladderCards = items.filter(function (it) { return (it.ids || [it.id]).some(function (id) { return /^vocab_Ladder_/.test(id); }); });
      var shown = ids.filter(function (id) { return /^vocab_Ladder_/.test(id); });
      if (ladderCards.length > 1) fail('Ladder Vocabulary takes ' + ladderCards.length + ' cards, expected 1');
      if (shown.slice().sort().join() !== q.vocabLevels.slice().sort().join()) fail('Ladder Vocabulary levels ' + (shown.join(', ') || 'none') + ', expected ' + q.vocabLevels.join(', '));
    }
    if (q.parseAge) {
      var a = res.q && res.q.age;
      if (!a || a.min !== q.parseAge[0] || a.max !== q.parseAge[1]) fail('parsed age ' + (a ? a.min + '-' + a.max : 'none') + ', expected ' + q.parseAge.join('-'));
    }
    if (q.kidNote != null && !!res.kidNote !== q.kidNote) fail('kid-themed note ' + (res.kidNote ? 'shown' : 'not shown'));
    if (q.kidTagged) items.forEach(function (it) {
      var kid = (it.ids || [it.id]).every(function (id) { return byId[id] && byId[id].kid; });
      if (kid && !it.kid) fail('kid-themed card without tag: ' + (it.ids || [it.id]).join('/'));
    });
    if (q.forbid) {
      var blob = JSON.stringify({ items: items, kind: res.kind });
      q.forbid.forEach(function (s) { if (blob.indexOf(s) >= 0) fail('contains forbidden text ' + s); });
    }
    return { ok: fails.length === 0, fails: fails };
  }

  return { checkQuestion: checkQuestion, runQuestion: runQuestion, idsOf: idsOf, firstGame: firstGame, planOrder: planOrder };
});
