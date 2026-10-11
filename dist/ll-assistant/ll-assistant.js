/*! Ladder Lessons game finder. Runs on the visitor's device. No server, no API. */
//
// Page load cost: this small file plus ll-assistant.css, and one button.
// It only draws the button, keeps the widget's typing away from page scripts,
// hides the widget behind your pop-ups (data-avoid) and spots a plan link.
// Everything else loads the first time the teacher opens the widget:
//   - ll-assistant-app.js: the finder itself (matching, the English-Chinese
//     word list, the lesson plan, sending the plan) and catalogue.compact.json
//   - on capable desktops, a WebGPU check and one small file from the model host
//   - after the download click: ll-worker.js, vendor/web-llm.js, model weights
//
// Script tag options (all optional):
//   data-position="bottom-right" | "bottom-left"
//   data-offset-x="16" data-offset-y="16"   distance from the corner in px
//   data-avoid=".email-gate"                hide the widget while any match is visible
//   data-ai="off"                           never offer the AI (keyword matching only)
//   data-lang="en" | "zh"                   label language before the teacher types
//   data-clarity="mask" | "pause"           Microsoft Clarity: keep recording the widget with
//                                           every clue removed (default), or pause Clarity
//                                           while the widget is open
//   data-no-ui                              load the finder only, no button (tests)

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.LLAssistant = api; api.boot(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // scripts/build.mjs adds a version to this name in dist/, so a cached copy of
  // one file is never paired with a newer copy of the other.
  var APP_FILE = 'll-assistant-app.js?v=0c52cb9b1d';
  var LAUNCHER = { en: 'Find a game', zh: '幫我揀遊戲' };
  var RETRY = { en: 'Try again', zh: '再試一次' };

  // State shared with the finder once it has loaded (ll-assistant-app.js).
  var S = { turns: [] };
  var api;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      // Clicks are dispatched from one window listener (see boot), so pause mode
      // can keep them from session recorders.
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { if (ev === 'click') n._llClick = attrs.on[ev]; else n.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function inRoot(node) { return !!(S.root && node && node.nodeType && S.root.contains(node)); }
  // The widget's own nodes, for the click and pointer filters below. The host's
  // email form (LLAssistantHost.sendPlan) sits inside the widget: its clicks,
  // focus and submit reach it as usual, but typing events (input, keys, change,
  // clipboard) stop at the widget like everywhere else in it, so no session
  // recorder gets a fingerprint of the email address typed there.
  function ours(node) {
    if (!inRoot(node)) return false;
    var e = node.nodeType === 1 ? node : node.parentElement;
    return !(e && e.closest && e.closest('.ll-sh-m'));
  }

  function selectionInRoot() {
    var sel = document.getSelection && document.getSelection();
    return !!(sel && (ours(sel.anchorNode) || ours(sel.focusNode))) || ours(document.activeElement);
  }

  function boot() {
    if (typeof document === 'undefined' || S.booted) return;
    S.booted = true;
    var script = document.currentScript || document.querySelector('script[src*="ll-assistant.js"]');
    var ds = (script && script.dataset) || {};
    S.base = ds.base || (script && script.src ? script.src.replace(/[^/]*(\?.*)?$/, '') : './');
    S.aiOff = ds.ai === 'off' || /[?&]llai=off\b/.test(location.search);
    S.defaultLang = ds.lang === 'zh' || ds.lang === 'en' ? ds.lang : (/^zh/i.test(document.documentElement.lang || '') ? 'zh' : 'en');
    S.lang = S.defaultLang;
    S.clarityMode = ds.clarity === 'pause' ? 'pause' : 'mask';
    S.ai = 'unknown';
    if ('noUi' in ds) { load(); return; }

    // Typing never reaches page-level listeners such as session recorders:
    // these window listeners run first and stop the events at the widget.
    window.addEventListener('input', function (e) {
      if (!inRoot(e.target)) return;
      e.stopImmediatePropagation();
      if (S.app && e.target === S.input) S.app.onInput();
    }, true);
    // Key, text-editing and clipboard events from the widget stop here too,
    // so no page script sees the keys or text typed into the widget.
    ['change', 'keyup', 'keypress', 'beforeinput', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend',
      'select', 'cut', 'copy', 'paste'].forEach(function (type) {
      window.addEventListener(type, function (e) { if (inRoot(e.target)) e.stopImmediatePropagation(); }, true);
    });
    window.addEventListener('keydown', function (e) {
      if (!inRoot(e.target)) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { close(); return; }
      // keyCode 229: Enter that confirms a Chinese input-method word (Safari order)
      if (S.app && e.target === S.input && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); S.app.submit(); }
    }, true);
    window.addEventListener('click', function (e) {
      if (!ours(e.target)) return;
      if (S.clarityMode === 'pause') e.stopImmediatePropagation();
      for (var n = e.target; n && n !== document; n = n.parentNode) {
        if (n._llClick) { if (!n.disabled) n._llClick(e); return; }
        if (n === S.root) return;
      }
    }, true);
    // Pause mode: nothing that happens inside the widget reaches page-level
    // listeners (pointer, scroll, focus), so a recorder sees no widget activity.
    ['mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
      'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'scroll', 'focus', 'blur', 'focusin', 'focusout',
      'dblclick', 'contextmenu', 'selectstart', 'selectionchange', 'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (e) {
        if (S.clarityMode === 'pause' && (ours(e.target) || (type === 'selectionchange' && selectionInRoot()))) e.stopImmediatePropagation();
      }, { capture: true, passive: true });
    });
    // Escape on the page itself closes the widget; Escape in a page field is the page's.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.open && (e.target === document.body || e.target === document.documentElement)) close();
    });

    // CSS: added once. The root is fixed-position inline, so nothing on the
    // page moves; it stays invisible until the stylesheet has loaded.
    var root = el('div', {
      id: 'll-assistant', 'class': 'll-root ll-pos-' + (ds.position === 'bottom-left' ? 'left' : 'right'),
      'data-clarity-mask': 'true', 'data-nosnippet': true,
      style: 'position:fixed;bottom:0;' + (ds.position === 'bottom-left' ? 'left' : 'right') + ':0;width:0;height:0;z-index:2147483000;visibility:hidden;',
    });
    if (ds.offsetX) root.style.setProperty('--ll-x', parseInt(ds.offsetX, 10) + 'px');
    if (ds.offsetY) root.style.setProperty('--ll-y', parseInt(ds.offsetY, 10) + 'px');
    S.root = root;

    var show = function () { root.style.visibility = ''; };
    if (!document.querySelector('link[data-ll-assistant]')) {
      var link = el('link', { rel: 'stylesheet', href: S.base + 'll-assistant.css', 'data-ll-assistant': true });
      link.onload = show; link.onerror = show;
      document.head.appendChild(link);
    } else show();

    // The launcher always uses the page's language, never the conversation's.
    S.launcherText = el('span', { 'class': 'll-launcher-text', text: LAUNCHER[S.defaultLang] });
    S.launcher = el('button', { type: 'button', 'class': 'll-launcher ll-btn', 'aria-expanded': 'false', 'aria-controls': 'll-panel', on: { click: toggle } }, [
      el('span', { 'class': 'll-launcher-icon', 'aria-hidden': 'true', text: '✦' }),
      S.launcherText,
    ]);
    root.appendChild(S.launcher);
    (document.body || document.documentElement).appendChild(root);

    if (ds.avoid) watchAvoid(ds.avoid);

    // A plan link ("Send this plan to my laptop") ending in #llplan=... opens the widget with that plan.
    window.addEventListener('hashchange', planFromHash);
    planFromHash();
  }

  // The finder, loaded once, the first time it is needed.
  function load() {
    if (S.loading) return S.loading;
    S.loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = S.base + APP_FILE;
      s.async = true;
      s.onload = function () { if (S.app) resolve(S.app); else { S.loading = null; reject(new Error('finder did not start')); } };
      s.onerror = function () { S.loading = null; s.remove(); reject(new Error('finder did not load')); };
      document.head.appendChild(s);
    });
    return S.loading;
  }

  // Called by ll-assistant-app.js when it has loaded: from then on the finder
  // does the work, and its core and internals are on window.LLAssistant.
  function attach(app) {
    S.app = app.init(S);
    api.core = app.core;
    api.internals = app.internals;
  }

  function planFromHash() {
    var m = /[#&]llplan=([^&]*)/.exec(location.hash || '');
    if (!m || !S.root) return;
    try { S.planCode = decodeURIComponent(m[1]); } catch (e) { S.planCode = m[1]; }
    if (!S.open) open();
    else if (S.app) S.app.showSavedPlan();
  }

  function watchAvoid(selector) {
    var pendingCheck = false;
    function visible(n) {
      if (!n.isConnected || !n.getClientRects().length) return false;
      var cs = getComputedStyle(n);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    }
    function check() {
      pendingCheck = false;
      var hide = false;
      try { hide = Array.prototype.some.call(document.querySelectorAll(selector), visible); } catch (e) { hide = false; }
      // While hidden, keep checking: a pop-up that fades out makes no further DOM change.
      if (hide) { S.root.setAttribute('hidden', ''); schedule(); } else S.root.removeAttribute('hidden');
    }
    function schedule() { if (!pendingCheck) { pendingCheck = true; setTimeout(check, 200); } }
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) if (!S.root.contains(list[i].target)) { schedule(); return; }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'] });
    window.addEventListener('resize', schedule);
    check();
  }

  function toggle() { if (S.open) close(); else open(); }

  // The first open loads the finder; the button says it is busy meanwhile, and
  // "Try again" if the file could not be loaded.
  function open() {
    if (!S.root) return;
    if (S.app) { S.app.open(); return; }
    S.launcher.setAttribute('aria-busy', 'true');
    load().then(function (app) {
      S.launcher.removeAttribute('aria-busy');
      S.launcherText.textContent = LAUNCHER[S.defaultLang];
      app.open();
    }, function () {
      S.launcher.removeAttribute('aria-busy');
      S.launcherText.textContent = RETRY[S.defaultLang];
    });
  }

  function close() { if (S.app) S.app.close(); }

  api = {
    boot: boot,
    open: function () { boot(); open(); },
    close: function () { if (S.open) close(); },
    // Loads the finder without opening it (demo page and tests).
    load: function () { return load().then(function () { return api; }); },
    _attach: attach,
    // Until the finder has loaded; then its own internals take over.
    internals: {
      state: function () { return { ai: S.ai, device: S.device, bytes: S.bytes, lang: S.lang, clarityMode: S.clarityMode, open: !!S.open, cat: !!S.cat }; },
    },
  };
  return api;
});
