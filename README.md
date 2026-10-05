# Ladder Lessons game finder

A small widget for ladderlessons.com. A teacher types who they are teaching (age, level, skill, lesson length) and gets 1 to 3 games from the catalogue, each with a direct link, a free or paid label and one line on how to run it in class.

It runs entirely in the visitor's browser. No API key, no backend, no cost per use.

- On capable desktops it can use a small AI model through [WebLLM](https://github.com/mlc-ai/web-llm) (WebGPU), after the teacher clicks a download button.
- Everywhere else, and whenever the AI fails, a keyword recommender gives the answer instead. It only uses `catalogue.json`.

---

## Quick start on a Mac (no Node needed)

Open **Terminal** and paste these lines one at a time. The server must be started **inside the project folder**. Started anywhere else, every page is a 404.

```bash
cd ~
git clone https://github.com/sharichung/ladder-lessons-assistant.git
cd ladder-lessons-assistant
python3 -m http.server 8080
```

Then open **http://localhost:8080/** in Chrome. It links to the demo page and the model test. Press `Ctrl + C` in Terminal to stop the server.

Next time, you only need:

```bash
cd ~/ladder-lessons-assistant
git pull
python3 -m http.server 8080
```

- If `git` asks you to install the "command line developer tools", click Install, wait for it to finish, then run the `git clone` line again.
- Without git, use GitHub › **Code** › **Download ZIP**. Unzip it, type `cd ` (with a space) in Terminal, drag the unzipped folder onto the Terminal window, press Enter, then run `python3 -m http.server 8080`.
- `npm install` and `npm test` must also be run inside this folder.

---

## What to deploy

Deploy **one folder: `dist/ll-assistant/`**. Copy it as-is into the main site, for example to `/ll-assistant/`.

| File | Size (gzip) | When it loads |
|---|---|---|
| `ll-assistant.js` | 49 KB (17 KB) | Page load, `defer` |
| `ll-assistant.css` | 7 KB (2 KB) | Page load, added by the script |
| `catalogue.compact.json` | 39 KB (16 KB) | When the teacher opens the widget |
| `ll-worker.js` | 3 KB | Only after the download click, or when the model is already cached |
| `vendor/web-llm.js` | 6.3 MB (2.2 MB) | Only after the download click, or when the model is already cached |
| `vendor/web-llm.LICENSE.txt` | | Apache 2.0 licence for WebLLM. Keep it with the library |

Then add one line before `</body>` on the pages where teachers should see it:

```html
<script src="/ll-assistant/ll-assistant.js" defer data-avoid="#your-email-gate"></script>
```

- Replace `#your-email-gate` with the CSS selector of the email gate. The widget hides itself while any element matching that selector is visible. You can list several, separated by commas.
- **Put it on library and browse pages, not on game pages.** Teachers share the game page on screen, and the button would be visible to students.
- The folder must be on the same domain as the page, because browsers only start Web Workers from the same origin.

Optional attributes on the script tag:

| Attribute | Default | Effect |
|---|---|---|
| `data-position` | `bottom-right` | Use `bottom-left` if the right corner holds game or page controls |
| `data-offset-x` / `data-offset-y` | `16` | Distance from the corner in px |
| `data-avoid` | none | Hide the widget while these elements are visible |
| `data-lang` | from `<html lang>` | `en` or `zh` for the labels before the teacher types |
| `data-ai` | on | `off` gives keyword matching only. `?llai=off` in the URL does the same, which is handy for testing |

Brand colours are CSS variables at the top of `ll-assistant.css`, such as `--ll-accent`. Override them on `#ll-assistant` in the site CSS.

---

## The model

| | |
|---|---|
| Model | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (Qwen2.5 0.5B Instruct, 4-bit) |
| Licence | Apache 2.0 (Qwen2.5-0.5B-Instruct) |
| Download | Shown on the button in MB. The widget works it out from the model host when the widget opens: exact weight sizes from `tensor-cache.json`, plus the tokenizer and the runtime. **Not yet measured on a real machine.** See [Measurements](#measurements). |
| GPU memory | ~945 MB, from WebLLM's own figure (`vram_required_MB` in WebLLM 0.2.85) |
| WebLLM | 0.2.85, pinned in `package.json` and copied into `vendor/` |

### Where everything is served from

| What | Served from | If that host is down |
|---|---|---|
| Widget, catalogue, worker, WebLLM library | **Your site** (`dist/ll-assistant/`) | n/a |
| Model weights, tokenizer, config | **huggingface.co** (third party, `mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC`) | The size check fails, so the AI is not offered and teachers get keyword matching. If it fails during a download, the widget switches to keyword matching and keeps what the teacher typed. Teachers who already downloaded the model are not affected: it loads from the browser cache. **Your pages are never affected**: nothing is fetched from these hosts until the widget is opened. |
| Model runtime (`.wasm`) | **raw.githubusercontent.com** (third party, `mlc-ai/binary-mlc-llm-libs`) | Same as above |

To remove both third parties later, host the model files on your own domain and point WebLLM's `appConfig` at them. Check your host's per-file size limit first.

If the site ever adds a Content-Security-Policy header, it needs:
- `worker-src 'self'`
- `script-src 'self' 'wasm-unsafe-eval'`
- `connect-src` for huggingface.co, its download CDN hosts and raw.githubusercontent.com

---

## How it works

1. **Page load.** Only `ll-assistant.js` and `ll-assistant.css` load. The button is `position: fixed`, so nothing on the page moves; the tests measure layout shift as 0. No WebLLM, no catalogue, no network calls to anyone else.
2. **Teacher opens the widget.** It fetches `catalogue.compact.json` and checks the device. The AI is offered only when **all** of these are true:
   - not a phone or tablet: iPhone, iPad, Android and other mobile user agents are excluded, as is an iPad in desktop mode
   - not an in-app browser: Instagram, Facebook, WhatsApp, LINE, WeChat, TikTok, Threads and Android WebView are excluded
   - WebGPU is present and returns a real GPU adapter, not a software one
   - the GPU supports `shader-f16`, which this model build needs
   - `navigator.deviceMemory` is at least 4 GB, where the browser reports it
   - the browser has enough storage quota for the download
   - the model host answers the size check

   Otherwise the widget simply works with keyword matching. There is no AI button, no error and no apology.
3. **AI offered.** The button reads `Download AI · N MB · one-time download`. Nothing downloads until it is clicked. While downloading, it shows progress and a Cancel button, and teachers can keep using keyword matching meanwhile. Files are stored in the browser's Cache API (`webllm/model`, `webllm/config`, `webllm/wasm`).
4. **Second visit.** If every model file is already in the cache, the AI starts on open without a download.
5. **Each question.**
   1. Keyword matching narrows the 66 games to the best ~12 candidates.
   2. Only those candidates, without URLs or prices, go to the model with the system prompt.
   3. WebLLM's grammar engine forces the reply to be JSON matching a schema: `{"picks": [...]}`, where each id must be one of the candidate ids, or `{"ask": "..."}`. Asking is only allowed when the teacher gave neither age nor level, and only once per request.
   4. The widget validates the reply again: unknown ids are dropped, at most 3 picks are kept, and a free game is moved first.
   5. Titles, links, free/paid labels, descriptions and "how to run it" lines are always read from the catalogue. The model never writes them.
   6. If nothing valid comes back, the keyword result is shown.
6. **The model crashes, times out (45 s) or fails to load.** The widget switches to keyword matching for the rest of the visit, answers the same question that way and keeps what the teacher typed.

The system prompt is in `src/ll-assistant.js` (`SYSTEM_PROMPT`). It is the one you specified, with wording unchanged.

### Labels and language

Widget labels switch between English and Traditional Chinese to match the language the teacher types in. Game descriptions follow the same language, using `description_en` or `description_zh` from the catalogue.

One line is always visible:
- with the AI on: *"AI running on this device. It can be wrong. Nothing you type leaves your device."*
- with keyword matching: *"Matches by keyword on this device. Nothing you type leaves your device."*

---

## Privacy and analytics

- **Nothing the teacher types leaves the device.** There is no server. The model runs in the browser.
- **Network calls happen only after the widget is opened:**
  - the catalogue, from your site
  - on capable desktops, a size check on huggingface.co
  - after the click, the model download
  
  None of them include anything the teacher typed. Hugging Face and GitHub do see the visitor's IP address when the model is fetched, like any CDN.
- The widget does not ask for names, emails or anything about a specific child.
- **GA4.** If `gtag` is already on the page, the widget sends these anonymous events and nothing else:
  - `ll_ai_offered`
  - `ll_download_started`
  - `ll_download_finished`
  - `ll_fallback_shown`
  - `ll_game_click`
  
  Each carries only `event_category: "ll_assistant"`. If the page has no analytics, nothing is sent.
- **Microsoft Clarity.** If `clarity` is on the page, the same five events are sent as Clarity events. The widget's root has `data-clarity-mask="True"`, so Clarity masks everything inside it, including the teacher's message shown as a chat bubble. Clarity's default setting masks input boxes but not text displayed on the page. **Check this after deploying:** open the widget in an incognito window, type a message, then find that session in Clarity and confirm the widget area is masked.

---

## Filling in the missing catalogue fields

`catalogue.json` has no age band, level or how-to-run line. The widget treats them as optional until they exist:
- **Age and level** are matched through the existing keywords and descriptions only.
- **"How to run it"** falls back to the `mode` field: "Teacher-led on screen share." or "Students play on their own."

To add them:

1. Fill in `data/teacher-fields.csv` in Excel or Google Sheets. Keep the `id` column unchanged. The `hints_quoted_from_catalogue` column only quotes words already in the catalogue to help you.
   - `age_band`: one or more of `4-6`, `7-9`, `10-12`, `13-17`, `adult`, separated by `|`. Example: `7-9|10-12`
   - `level`: `pre-A1`, `A1`, `A2`, `B1`, `B2` or `C1`, or a range like `A2-B1`
   - `how_to_run_en`: one sentence
   - `how_to_run_zh`: optional, and the English line is shown when it is empty
2. Run `npm run build`. The build stops and lists every problem: an unknown id, a value outside the allowed list, or a Chinese line without an English one.
3. Deploy the new `dist/ll-assistant/catalogue.compact.json`.

Once a game has an age band, the recommender stops suggesting it for other ages. Level becomes a strong ranking signal. The model sees both in its candidate list.

When `catalogue.json` changes, rebuild the same way. It stays the only source of games: the build copies ids, titles, URLs and tiers exactly, and the unit tests check that nothing was added or renamed.

---

## Testing

```bash
npm install          # WebLLM 0.2.85 + playwright-core (dev only)
npm test             # build + unit tests + browser tests (headless Chromium)
npm run serve        # http://localhost:8080/  (or: python3 -m http.server 8080)
```

`npm test` needs a Chromium. It uses `$CHROME_PATH` if set, otherwise installed Google Chrome.

### What the automated tests cover

`tests/unit.test.mjs` runs in Node and checks:
- The compact catalogue matches `catalogue.json` exactly.
- The 15 fixed questions from `tests/questions.json` (kids, adults, IELTS, phonics, Cantonese and Traditional Chinese input, off-topic, a prompt-injection attempt and an empty message) go through the keyword recommender. Every link must exist in the catalogue, and an expected game must be in the picks.
- Bad model output is handled:
  - unknown ids, catalogue ids that were not candidates, URLs, prose, broken JSON, too many picks and duplicates
  - unsafe "ask" text (URLs, prices, "free" claims)
- The model never sees a URL.

`tests/e2e.test.mjs` runs in headless Chromium:
1. **WebGPU disabled.**
   - Page load fetches only the script and CSS.
   - Layout shift is 0.
   - The Clarity mask attribute is present.
   - No AI offer appears.
   - All 15 questions get answers with only catalogue links, and labels follow English or Chinese.
   - Free/paid tags match the catalogue.
   - The empty message is not sent.
   - Analytics payloads are anonymous.
   - The widget hides while the email gate is visible.
   - No model files are requested.
2. **No `navigator.gpu` at all:** the fallback appears.
3. **iPhone, Android, Instagram and Android WebView user agents:** no AI offer.
4. **Simulated capable GPU:**
   - The button shows the MB size.
   - Nothing downloads before the click.
   - The real worker and WebLLM load after the click, then fail because there is no GPU or model host here.
   - The widget falls back, the draft text stays in the box, and the right events fire.
5. **Download progress and Cancel.**
6. **AI path with a fake worker:**
   - fake ids and URLs are discarded
   - non-JSON output falls back to keywords
   - the ask flow works
   - a crash mid-session falls back and still answers the question
7. **Second visit with the model cached:** starts without a click and without a download event.

### Real-model test (run on your laptop)

1. `npm run serve`
2. Open `http://localhost:8080/tests/model-test.html` in desktop Chrome.
3. Click **Download model**, then **Run tests**, then **Copy report**, and send the report back.
4. To measure a cached start, reload the page and run it again.

It runs the same 15 questions through the real model using the widget's own code. It reports:
- rendered links not in the catalogue (must be 0)
- invalid model replies
- how often the expected game appears in the picks, for the AI and for keyword matching
- download size, measured from the browser cache
- model load time
- time to first answer
- median answer time
- page memory

**Pass rule:** 0 bad links, 0 invalid model replies, and the AI finds the expected game at least as often as keyword matching. If the 0.5B model fails, the agreed next step is `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`.

Always test the demo once in an incognito window. That is the only way to see a true first visit: the download button with nothing cached.

---

## Device support

**Honest status:** these were built and tested in a cloud container with no GPU and no access to Hugging Face. Only headless Chromium was actually run. Everything else is the expected behaviour from the device rules above, still to be confirmed on real devices.

| Browser | AI or fallback | Tested? | Notes |
|---|---|---|---|
| Desktop Chrome / Edge (Windows, macOS, ChromeOS), recent version | **AI offered** on most GPUs | Not on real hardware. The offer, download, cancel and fallback logic were tested with a simulated GPU in headless Chromium | Needs WebGPU with `shader-f16`. Older or integrated GPUs without it get the fallback |
| Desktop Chrome on Linux | Usually **fallback** | No | WebGPU is often not enabled on Linux |
| Desktop Safari | **AI** expected on Safari versions with WebGPU, if the GPU reports `shader-f16`. Older Safari: **fallback** | No | `navigator.deviceMemory` is not reported, so only the GPU and storage checks apply |
| Desktop Firefox | **Fallback** expected on most setups. AI only where Firefox exposes WebGPU **and** `shader-f16` | No | I am not certain which Firefox versions expose `shader-f16`. Please check with `demo.html` › "Check this device" |
| iPhone Safari | **Fallback** (by design) | User-agent rule tested in Chromium, not on an iPhone | Phones are excluded even when they have WebGPU: ~300 MB on mobile data and ~1 GB of GPU memory is not a good trade |
| Android Chrome | **Fallback** (by design) | User-agent rule tested in Chromium, not on a phone | Same reason |
| In-app webviews (Instagram, Facebook, WhatsApp, LINE, WeChat, Android WebView) | **Fallback** (by design) | Instagram and Android WebView user agents tested in Chromium | |
| Headless Chromium, WebGPU disabled | **Fallback** | **Yes**, `tests/e2e.test.mjs` | |
| Headless Chromium, software GPU (SwiftShader) | **Fallback** | **Yes**, manual probe | Adapter is a software fallback with no `shader-f16`, so it is rejected |

To fill in the real rows, open `demo.html` on each device and press **Check this device**. It prints the exact reason, such as `no-shader-f16` or `mobile`.

## Measurements

| Measure | Value |
|---|---|
| Page-load cost | 2 requests: `ll-assistant.js` 17 KB gzip + `ll-assistant.css` 2 KB gzip, both `defer`/async. Layout shift 0. **Measured** in headless Chromium |
| Model download size | **Not measured yet.** Shown on the button at runtime; `model-test.html` measures the real bytes in the cache |
| Time to first answer on a mid-range laptop | **Not measured yet.** Needs a real GPU; run `model-test.html` |
| Memory | ~945 MB GPU, which is **WebLLM's published estimate, not measured.** `model-test.html` reports the page's JS heap and tells you where to read the real GPU figure (Chrome Task Manager › GPU Process) |

---

## Repo layout

```
catalogue.json               the only source of games (from games/library.html)
data/teacher-fields.csv      age band, level, how-to-run, filled in by hand
src/                         widget source (plain JS + CSS, no framework)
scripts/build.mjs            builds dist/ll-assistant/ and validates the data
scripts/serve.mjs            local static server
dist/ll-assistant/           ← deploy this folder
demo.html                    local test page with test controls
tests/                       questions, unit tests, browser tests, model-test.html
```

`dist/` is committed so the folder can be copied without running Node. After editing `src/`, `catalogue.json` or the CSV, run `npm run build` and commit `dist/` too.
