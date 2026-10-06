# Ladder Lessons game finder

A small widget for ladderlessons.com. A teacher types who they are teaching (age or level, skill, lesson length) and gets 1 to 3 games from the catalogue, each with a button that opens the game, a plan label (Free / Parent / Teacher) and a Teacher-led or Student-solo tag.

It runs entirely in the visitor's browser. No API key, no backend, no cost per use.

- On capable desktops it can use a small AI model through [WebLLM](https://github.com/mlc-ai/web-llm) (WebGPU), after the teacher clicks a download button.
- Everywhere else, and whenever the AI fails, a keyword recommender gives the answer instead. It only uses `catalogue.json` and `ages.csv`.

---

## Quick start on a Mac (no Node needed)

Open **Terminal** and paste these lines one at a time. The server must be started **inside the project folder**. Started anywhere else, every page is a 404.

```bash
cd ~
git clone https://github.com/sharichung/ladder-lessons-assistant.git
cd ladder-lessons-assistant
python3 -m http.server 8080
```

Then open **http://localhost:8080/** in Chrome. It links to:
- the demo page
- the demo with the site's fonts and colours
- the model test

Press `Ctrl + C` in Terminal to stop the server.

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
| `ll-assistant.js` | 70 KB (23 KB) | Page load, `defer` |
| `ll-assistant.css` | 12 KB (3 KB) | Page load, added by the script |
| `catalogue.compact.json` | 41 KB (15 KB) | When the teacher opens the widget |
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
| `data-clarity` | `mask` | `pause` pauses Microsoft Clarity while the widget is open (see [Privacy](#privacy-and-analytics)) |

**Colours and fonts** come from the site's own tokens: the names in `ll-tokens.css`, such as `--coral`, `--ink` and `--ff-head`.
- The widget reads them from the page's `:root`.
- Each one has a fallback value copied exactly from `ll-tokens.css`, so the widget looks right on a page without them.
- If the site renames a token, rename it in `src/ll-assistant.css` and run `npm run build`. A unit test fails if the CSS uses a colour or token name that is not in `ll-tokens.css`.

---

## Data: catalogue.json, ages.csv, teacher-fields.csv

| File | What it holds | Who edits it |
|---|---|---|
| `catalogue.json` | The only source of games: ids, titles, URLs, plans, descriptions, keywords | Exported from `games/library.html` |
| `ages.csv` | Per game: `age_min`, `age_max`, `level_min`, `level_max`, `kid_theme` | You |
| `data/teacher-fields.csv` | Optional per-game "how to run it" line (`how_to_run_en`, `how_to_run_zh`) | You |
| `ll-tokens.css` | Colours, radii, shadows and fonts copied from `library.html` | Copied from the site |

**Building:** run `npm run build` to merge all of this into `dist/ll-assistant/catalogue.compact.json`.
- A blank cell stays blank and means "no limit". Nothing is guessed.
- The build stops and lists every problem:
  - an unknown or missing id
  - a title or plan that differs from `catalogue.json`
  - an age that is not a whole number
  - a level outside pre-A1 to C2
  - `kid_theme` other than `Y` or blank
- Unit tests check that the compact file matches `catalogue.json` and `ages.csv` exactly.

**How the widget uses the data:**
- **age_min is a hard filter.** A game is dropped when the student is younger than `age_min`. There is no upper age limit, because adult beginners use the same games, so `age_max` is kept in the file but never used.
- **Levels are a hard filter only when the teacher states a level.**
  - Codes: A1 to C2.
  - Words: beginner = pre-A1/A1, elementary = A1/A2, pre-intermediate = A2, intermediate = B1, upper-intermediate = B2, advanced = B2/C1.
  - A game with no level data always passes.
- **kid_theme = Y is a ranking signal, never a filter.** For teen and adult queries those games go below all others, never first, and get a **Kid-themed** tag.
- **"How to run it" appears only for games that have their own line** in `teacher-fields.csv`. Every card shows a Teacher-led / Student solo tag.

Ladder Talk's `age_min` is 10 (changed from 16 because teen topics were added).

---

## How a question is answered

### Reading the question

**Ages become number ranges**, with the Hong Kong mapping:

| Written as | Age range |
|---|---|
| K1–K3 | 3–6 (K1 = 3–4) |
| P1–P6 / Primary N / 小N | 6–12 (P1 = 6–7, P5 = 10–11) |
| F1–F6 / S1–S6 / Form N / Secondary N / 中N | 12–18 (F4 = 15–16) |
| DSE | 15–18 |
| Year N (UK) | N+5 to N+6 |
| Grade N (US) | N+6 to N+7 |

Spaces and full stops don't matter: "P.5", "Primary5", "小 五" and "F.4" all work.

**Which age the filter uses:**
- An exact age or school year uses the **youngest** age of its range. So Form 4 (15–16) does not get games with `age_min` 16.
- Words like "kids", "primary", "secondary" or "adult" are used only when no exact age is given, and use the **oldest** age of their range.

**Teen and adult signals** push kid-themed games down:
- teen, secondary, Form/S/F/中 N, adult, 成人, DSE, IELTS
- an exact age of 13 or more
- business, 商業, 商務, and work in the sense of "at work", "for work", "office" or 上班

Exception: when the teacher states an age under 13, "business" and "work" do not count. So "9 year old business game" still gets Mini Business Tycoon Junior.

### The answer

**Number of games.** Under 30 minutes gives 1–2 games; 30 minutes or more gives 2–3; no length given gives up to 3. If the strong matches run out, the next games of the same skill that pass the filters fill the gap.

**Free game first.** A free game goes first when all of these hold:
- it passed the filters
- it matches the query's topic, not just a word like "adult" or "kids"
- it scores at least 60% of the best game

This applies in both modes. In AI mode, if the model leaves it out, the widget puts it in.

**Ladder Vocabulary** takes one card, with a button for each level that fits the age and any stated level. For example, a P5 student gets A1 · A2 · B1, and "A2" gives only A2.

**When the widget asks instead of answering:**
- **An age or grade with no skill** ("Form 4 student", "6歲 beginner"): one question, "Which skill?", with numbered choices 1) Speaking 2) Writing 3) Grammar 4) Vocabulary 5) Phonics 6) Listening, or 1) 口語 2) 寫作 3) 文法 4) 詞彙 5) 拼讀 6) 聽力 in Chinese. This happens only when the rest of the message is teaching words. "My 8 year old wants a pizza recipe" still gets the off-topic reply.
- **Reading:**
  - Under 8, reading means phonics.
  - From 8, the widget says there is no reading game yet and offers 1) Vocabulary 2) Grammar 3) Listening.
  - If the age range crosses 8, the youngest age decides.
  - With no age, it asks the age first.
- **No game of that skill for this age** (e.g. "5 year old grammar"): it says so, for example "Grammar games start at age 8", and offers the skills that do have games.

**Older learners where every game is kid-themed** ("adult business english"; all four Money English games are kid-themed):
- The best game that isn't kid-themed goes first (Quick Fire Flashcards today).
- Then the line "No Money English game is designed for teens or adults yet. These are kid-themed:".
- Then the kid-themed games, older ones first.

Ladder Talk and Ladder Frames do **not** come up for "adult business english": their keywords don't mention business or work. Ladder Talk matches only on "adult" and is second in line. Adding words such as `business` `work` `商業` `工作` to their keywords in the source would bring them in.

**Short answers join the previous question.** A digit, a chip, or a reply that only gives an age, or only gives a skill, is added to the earlier question. A new full question starts fresh.

### AI mode

1. The questions above, off-topic messages and "no game for this age" are decided by the keyword rules and never reach the model.
2. The best 12 games that pass the filters go to the model as candidates. Each candidate carries `age_min`, its level range and `kid_theme`, but no URL or price.
3. WebLLM's grammar engine forces a JSON reply: `{"picks": [...]}` using candidate ids only, as many as the lesson length allows. It can reply `{"ask": "..."}` only when the teacher gave neither age nor level.
4. The widget then validates the picks and applies the same post-processing as keyword mode, in this order:
   - hard filters
   - top up to the minimum number of games
   - kid-themed games down
   - free game first
   - trim to the maximum
5. A model question is never shown as written: the widget shows its own "How old are they?" with age buttons.
6. Bad output falls back to keyword matching. So does a crash, a timeout (45 s) or a failed download, for the rest of the visit, and the teacher's text is kept.

The system prompt in `src/ll-assistant.js` (`SYSTEM_PROMPT`) is the one you specified, unchanged.

### Language

One language per conversation. It changes only when a message has Chinese characters or at least two English words, so answering "2", "B1" or "DSE" keeps it. When it changes, every earlier answer is redrawn in the new language. Plan labels:
- English: Free / Parent / Teacher
- Chinese: 免費 / 家長版 / 老師版

---

## Look and feel

- **Colours and shapes:**
  - panel: `--cream`
  - cards: white with `--sh-card`, no outline
  - the teacher's message bubble: `--coral-pale` with `--ink` text
  - secondary text: `--ink-soft`. Not `--muted`, which is too faint to read.
  - progress bar: 12px, `--teal` fill (style guide)
- **Plan labels** copy the library page's `.tier` rule exactly, including its colour contrast as on the site:
  - free: `--tier-free`
  - parent: `--yellow`
  - teacher: `--purple-1`
  - text: `--ink`
- **The launcher, Download and Find games buttons** copy the site CTA (`_brand/ll-funnel.css` `.llf__btn`): coral gradient, ink text, 3px ink border, pill shape, 48px tall, with the same hover, pressed and disabled states.
- **Fonts:**
  - headings use `--ff-head` (Fredoka), body text `--ff-body` (Nunito), with Noto Sans HK for Chinese
  - the widget downloads no fonts itself
  - Chinese headings are weight 700 with 0.02em letter spacing
  - the text box and the teacher's own bubble use system fonts only: Google Fonts serves Chinese in character ranges, so a web font there would fetch files based on the characters typed
- **The demo page** loads no fonts and no tokens by default, which keeps the automated tests free of outside requests. Use `demo.html?site=1` to see it with `ll-tokens.css` and the site's Google Fonts.

---

## Privacy and analytics

**Header:**
- **Line 1 (always shown):** "Runs in your browser. What you type is not sent to us." / 「喺你部機運行。你打嘅內容唔會傳送畀我哋。」
- **Line 2:**
  - AI model loaded: "AI suggestions can be wrong." / 「AI 建議可能有錯。」
  - Keyword mode: "Matches by keyword." / 「按關鍵字配對。」

**What leaves the device:**
- There is no server. Nothing the teacher types, and nothing worked out from it, is sent anywhere by the widget.
- No network request is made per question. The tests check this after every one of the fixed questions.
- The conversation lives in page memory only and is gone on reload.
- `localStorage` holds one number: `ll-ai-bytes:<model id>`, the download size.
- The Cache API holds the model files.
- **Network calls happen only after the widget is opened:**
  - the catalogue, from your site
  - on capable desktops, a size check on huggingface.co
  - after the click, the model download from huggingface.co and raw.githubusercontent.com

  None of them contain anything typed. Those hosts see the visitor's IP address, like any CDN.

**Analytics events.** The widget only uses analytics the page already has. These are all the calls it makes:

| Event | When | GA4 call | Clarity call |
|---|---|---|---|
| `ll_ai_offered` | The download button is shown (or a cached model starts), once per page | `gtag('event', 'll_ai_offered', {event_category: 'll_assistant'})` | `clarity('event', 'll_ai_offered')` |
| `ll_download_started` | The teacher clicks Download | same pattern | same pattern |
| `ll_download_finished` | The model has loaded after a download | same pattern | same pattern |
| `ll_fallback_shown` | Keyword mode is used because the device can't run the AI or the AI failed, once per page | same pattern | same pattern |
| `ll_game_click` | A game button is clicked | same pattern | same pattern |

- The only parameter is `event_category: "ll_assistant"`. No query text, no game id, no plan, no language.
- GA4's own script adds its standard fields to every event (page URL, referrer, page title, browser language, screen size, its client and session ids). That is normal page analytics, not data from the conversation.
- The widget has no `<form>`, so GA4's automatic form events never fire from it.
- **Opening a game is a normal visit to that game's page on your site.** Your analytics count it like any page view, including that the visitor came from this page. That shows which game was opened, never what was typed.

**Microsoft Clarity (decision 7B: keep recording, remove every clue):**
- The widget's root has `data-clarity-mask="true"`, so Clarity hides all text inside it. Clarity only checks that this attribute is present; the value doesn't matter.
- Typing, change and key events stop at the widget, before Clarity's listeners. This matters because without it, Clarity uploads an encoded fingerprint (a hash) of the typed text when the text box loses focus. The browser tests run the real Clarity library to confirm the fingerprint no longer appears.
- Games open from buttons, not links, so Clarity's click records carry no game address.
- The widget's page code holds no game ids, sources or `lang` attributes. Plan colours come from a one-character code (`data-t="1|2|3"`), and class names never name a game, plan, skill or language.
- **What Clarity still records:**
  - where clicks happen inside the widget
  - that typing happened
  - the character count of each masked text, such as a card title or description. Someone could match those counts against the catalogue to guess which games were shown.
- **For a stronger guarantee, add `data-clarity="pause"`** to the script tag:
  - Clarity pauses while the widget is open.
  - On close, the conversation is cleared from the page, kept in memory, and redrawn when the widget reopens. The labels go back to the page's language before Clarity resumes.
  - Clarity then sees nothing from inside the open widget.
- **After deploying, check both GA4 and Clarity:**
  - **Clarity:** open the widget in an incognito window, type a message and click a game. Find that session in Clarity and confirm the widget area shows masked blocks only, with no game addresses.
  - **GA4:** in DebugView, confirm a game click shows only `ll_game_click`, with no automatic `click` event carrying a `link_url`.
- **Google Fonts:** the site loads Chinese fonts from Google Fonts in character ranges. When the widget shows Chinese labels, Google may serve those label characters. It never serves the characters the teacher types, because the text box and the teacher's bubble use system fonts.
- The widget never asks for a name, an email or anything about a specific child. It makes no security or certification claims.

---

## The model

| | |
|---|---|
| Model | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (Qwen2.5 0.5B Instruct, 4-bit) |
| Licence | Apache 2.0 (Qwen2.5-0.5B-Instruct) |
| Download | Shown on the button in MB. Worked out from the model host when the widget opens. **Not yet measured on a real machine.** See [Measurements](#measurements). |
| GPU memory | ~945 MB, from WebLLM's own figure (`vram_required_MB` in WebLLM 0.2.85) |
| WebLLM | 0.2.85, pinned in `package.json` and copied into `vendor/` |

### Where everything is served from

| What | Served from | If that host is down |
|---|---|---|
| Widget, catalogue, worker, WebLLM library | **Your site** (`dist/ll-assistant/`) | n/a |
| Model weights, tokenizer, config | **huggingface.co** (third party) | The AI isn't offered; teachers get keyword matching. A download that fails midway switches to keyword matching and keeps the teacher's text. Teachers with the model cached are unaffected. **Your pages are never affected.** |
| Model runtime (`.wasm`) | **raw.githubusercontent.com** (third party) | Same as above |

If the site ever adds a Content-Security-Policy header, it needs:
- `worker-src 'self'`
- `script-src 'self' 'wasm-unsafe-eval'`
- `connect-src` for huggingface.co, its download hosts and raw.githubusercontent.com

---

## Testing

```bash
npm install          # WebLLM 0.2.85, playwright-core, clarity-js (dev only)
npm test             # build + unit tests + browser tests + keyword before/after table
npm run compare      # just the before/after table -> tests/results/keyword-before-after.md
npm run serve        # http://localhost:8080/  (or: python3 -m http.server 8080)
```

**Chromium:** `npm test` uses `$CHROME_PATH` if set, otherwise installed Google Chrome.

**The question set:**
- `tests/questions.json` has 61 fixed questions in English and Chinese. They cover every failing case from the test round plus the reviewers' edge cases:
  - kids, adults, IELTS, DSE and Form 4
  - phonics, reading and vocabulary levels
  - lesson lengths
  - off-topic messages, with and without an age
  - prompt injection in English and Chinese
  - an empty message
- One checker, `tests/check.js`, judges every mode: unit tests, browser tests, the before/after script and the model test.

`tests/unit.test.mjs` (Node) checks:
- **Data merge:**
  - the compact catalogue matches `catalogue.json` and `ages.csv` exactly
  - `age_max` changes nothing
- **Question reading:**
  - the age mapping, including false matches such as "There's 3 kids" not reading as S3, and 其中一 not reading as 中一
  - levels, lesson length, skills
  - teen/adult signals and the under-13 exception
- **All fixed questions** in keyword mode.
- **AI post-processing** with scripted models:
  - free game first
  - 2–3 games for 50 minutes
  - kid-themed never first
  - questions never sent to the model
  - the model's question text never shown
  - bad output and crashes
- **Text and style:**
  - privacy and plan-label wording
  - no security or name wording
  - the CSS uses only `ll-tokens.css` colours and names, with exact fallbacks
  - plan label and CTA rules match the site

`tests/e2e.test.mjs` (headless Chromium) checks:
1. **Keyword mode, WebGPU off:**
   - page load fetches only the script and CSS; no layout shift
   - header wording
   - every fixed question through the real UI
   - card names, plan label wording and colour, mode, level and kid tags
   - each game button opens exactly its catalogue URL
   - no links, ids, `lang` attributes or `<form>` in the widget
   - email gate hiding
2. **Analytics:**
   - every analytics call exactly matches the allowed list
   - nothing typed appears in any payload
   - no network request after typing
   - URL, storage and console stay clean
3. **The real Microsoft Clarity library:**
   - no typed-text fingerprint, game URL, game id, game title or typed word reaches the upload
   - a deliberate break, with the change-event blocker removed, makes this test fail
4. **`data-clarity="pause"`:** paused while open, conversation cleared before it resumes.
5. **Language:** one language per conversation, earlier answers redrawn, "2" keeps Chinese.
6. **Choices:** skill question, reading and "no game for this age" answered by click.
7. **Narrow screens** (320, 375 and 768 px wide): panel fits, no sideways scroll, input and button on one row.
8. **Device and download:**
   - no `navigator.gpu`
   - phone and in-app user agents
   - simulated GPU: size shown, nothing before the click, failed download falls back
   - cancel
   - fake-model AI path, including crash
   - cached second visit

### Before and after (E3)

**Keyword mode:** `npm run compare` runs the old code (commit fb82fd2, kept in `tests/baseline/`) and the new code on the same questions with the same checker. Result: **before 26/60, after 60/60**. Full table: `tests/results/keyword-before-after.md`.

**AI mode (needs a real GPU):**
1. Start the server.
2. Open `http://localhost:8080/tests/model-test.html` in desktop Chrome, in a normal window.
3. Click **Download model**, then **Run tests**, then **Copy report**, and send the report back.

The page runs every question through the old and new code, in keyword and AI mode, with the same loaded model. It reports:
- pass counts for each of the four columns
- invalid model replies
- download size, measured in the cache
- load time
- time to first answer and median answer time
- page memory

**Pass rule:** no invalid model replies, and AI mode passes at least as many questions as keyword mode. If the 0.5B model fails, the agreed next step is `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`.

To see a true first visit (the download button with nothing cached), use the demo's **Delete the downloaded AI from this browser** button, or an incognito window. Incognito limits storage, so the AI button may not appear there.

---

## Device support

**Honest status:** built and tested in a cloud container with no GPU and no access to Hugging Face. Only headless Chromium was actually run. Everything else is expected behaviour from the device rules, still to be confirmed on real devices.

| Browser | AI or fallback | Tested? | Notes |
|---|---|---|---|
| Desktop Chrome / Edge (Windows, macOS, ChromeOS), recent version | **AI offered** on most GPUs | Not on real hardware. Offer, download, cancel and fallback tested with a simulated GPU | Needs WebGPU with `shader-f16` |
| Desktop Chrome on Linux | Usually **fallback** | No | WebGPU is often not enabled on Linux |
| Desktop Safari | **AI** expected where Safari has WebGPU and the GPU reports `shader-f16`; older Safari **fallback** | No | |
| Desktop Firefox | **Fallback** expected on most setups | No | I am not certain which versions expose `shader-f16`; check with `demo.html` › "Check this device" |
| iPhone Safari | **Fallback** (by design) | User-agent rule tested in Chromium | |
| Android Chrome | **Fallback** (by design) | User-agent rule tested in Chromium | |
| In-app webviews (Instagram, Facebook, WhatsApp, LINE, WeChat, Android WebView) | **Fallback** (by design) | Instagram and Android WebView user agents tested in Chromium | |
| Headless Chromium, WebGPU disabled | **Fallback** | **Yes** | |
| Headless Chromium, software GPU (SwiftShader) | **Fallback** | **Yes**, manual probe | Software adapter, no `shader-f16` |

## Measurements

| Measure | Value |
|---|---|
| Page-load cost | 2 requests: `ll-assistant.js` 23 KB gzip + `ll-assistant.css` 3 KB gzip. Layout shift 0. **Measured** in headless Chromium |
| Model download size | **Not measured yet.** `model-test.html` measures the real bytes in the cache |
| Time to first answer on a mid-range laptop | **Not measured yet.** Needs a real GPU; run `model-test.html` |
| Memory | ~945 MB GPU is **WebLLM's published estimate, not measured.** `model-test.html` says where to read the real figure |

---

## Repo layout

```
catalogue.json               the only source of games (from games/library.html)
ages.csv                     age_min, age_max, levels, kid_theme per game
ll-tokens.css                site tokens copied from library.html
LL_STYLE_GUIDE.md            brand style guide
data/teacher-fields.csv      optional per-game how-to-run lines
src/                         widget source (plain JS + CSS, no framework)
scripts/build.mjs            builds dist/ll-assistant/ and validates the data
scripts/serve.mjs            local static server
dist/ll-assistant/           ← deploy this folder
demo.html, index.html        local test pages
tests/                       questions, checker, unit, browser, compare, model-test, baseline (old code)
```

`dist/` is committed so the folder can be copied without running Node. After editing `src/`, `catalogue.json`, `ages.csv` or the CSV, run `npm run build` and commit `dist/` too.
