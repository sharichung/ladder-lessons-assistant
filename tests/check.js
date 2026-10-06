// One checker for every fixed question, shared by tests/unit.test.mjs,
// tests/e2e.test.mjs, tests/compare.mjs and tests/model-test.html, so keyword
// mode and AI mode are judged by the same rules.
//
// result: { kind: 'picks'|'ask'|'none', askType, items: [{id} | {family, ids}], q: parsed query (optional) }
// cat:    the prepared compact catalogue (byId), used to look up free and kid_theme.
//
// Question fields (all optional except text and expect):
//   expect      picks | none | ask-skill | ask-age | ask-reading | ask-noGames | nothing-sent
//   anyOf       at least one of these ids is shown
//   first       the first card is this game
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
  function firstGame(items) { return items && items.length ? (items[0].ids ? items[0].ids[0] : items[0].id) : null; }

  function checkQuestion(q, res, cat) {
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
    if (/^ask-/.test(want)) {
      var type = want.slice(4);
      if (res.kind !== 'ask' || res.askType !== type) fail('expected ask ' + type + ', got ' + res.kind + (res.askType ? ':' + res.askType : ''));
    }

    if (q.anyOf && !ids.some(function (id) { return q.anyOf.indexOf(id) >= 0; })) fail('none of anyOf shown (' + ids.join(', ') + ')');
    if (q.first && first !== q.first) fail('first is ' + first + ', expected ' + q.first);
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

  return { checkQuestion: checkQuestion, idsOf: idsOf, firstGame: firstGame };
});
