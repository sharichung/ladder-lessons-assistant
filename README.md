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
| `ll-assistant.js` | 97 KB (32 KB) | Page load, `defer` |
| `ll-assistant.css` | 15 KB (4 KB) | Page load, added by the script |
| `catalogue.compact.json` | 41 KB (16 KB) | When the teacher opens the widget |
| `ll-worker.js` | 3 KB | Only after the download click, or when the model is already cached |
| `vendor/web-llm.js` | 6.3 MB (2.2 MB) | Only after the download click, or when the model is already cached |
| `vendor/web-llm.LICENSE.txt` | | Apache 2.0 licence for WebLLM. Keep it with the library |

Then add one line before `</body>` on the pages where teachers should see it:

```html
<script src="/ll-assistant/ll-assistant.js" defer data-avoid="#your-email-gate, #your-lock-popup"></script>
```

- Replace `#your-email-gate` with the CSS selector of the email gate, and `#your-lock-popup` with the selector of the library's lock pop-up (the plan pop-up a locked game opens). The widget hides itself while any element matching these selectors is visible, so the pop-up is never behind the widget, and comes back when it closes, also after a fade-out. You can list several, separated by commas.
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
| `catalogue.json` | The only source of games: ids, titles, paths, plans, `in_public_build`, descriptions, keywords | Exported from `games/library.html` |
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
  - a `path` that does not start with `/`, or a paid game marked `in_public_build`
- Unit tests check that the compact file matches `catalogue.json` and `ages.csv` exactly.
- The compact file has each game's `path` and a flag for the 4 public (free) games. It has **no absolute address**: `url` and `app_url` are not copied, so the widget cannot link a paid game to ladderlessons.com.

**How the widget uses the data:**
- **age_min is a hard filter.** A game is dropped when the student is younger than `age_min`. There is no upper age limit, because adult beginners use the same games, so `age_max` is kept in the file but never used.
- **Levels are a hard filter only when the teacher states a level.**
  - Codes: A1 to C2.
  - Words: beginner = pre-A1/A1, elementary = A1/A2, pre-intermediate = A2, intermediate = B1, upper-intermediate = B2, advanced = B2/C1.
  - A game with no level data always passes.
- **kid_theme = Y is a ranking signal, never a filter.** For teen and adult queries those games go below all others, never first, and get a **Kid-themed** tag.
- **"How to run it" appears only for games that have their own line** in `teacher-fields.csv`. Every card says Teacher-led or Student solo on its plain meta line.

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

Spaces and full stops don't matter: "P.5", "Primary5", "小 五", "小.5" and "F.4" all work.

Other ways of writing ages and school years that are recognised:
- Written-out numbers: "Form One", "Primary Five", "Sec 2", "小學三年級", "中學一年級".
- Ages in words or other forms: "eight year old", "nine-year-old", "九歲", "七歲半", "9 y.o.", "Age: 9", "Age seven" and "my student is 9 years".
- An age with no unit, after a word for the student: "She is 7", "my son is ten", "my student is 12".
- Ranges: "6 and 10 years old", "kids from 5 to 7", "between 8 and 10", "students 6-7", "七至九歲", "七、八歲" and "seven to nine year olds". The youngest age is used.
- 高中 and 初中 count as secondary, like 中學.
- Not read as ages or school years:
  - "for 5 years", "3 years of English", "studied English 3 years", "lived here 5 years": "N years" is an age only with old, 歲, age or "is"
  - "其中一個" and "當中一個" (one of them) are not 中一
  - "Year 2 university" is not a primary school year
  - F1 the racing series ("loves F1", "F1 fan", "F1 迷") is not Form 1. With an adult or university word in the message, a Form/S/F year is ignored.
- DSE gives 15–18 only when no Form, S or 中N year is given. So "Form 5 DSE" stays 16–17 and keeps IELTS Speaking Room.

**Which age the filter uses:**
- An exact age or school year uses the **youngest** age of its range. So Form 4 (15–16) does not get games with `age_min` 16.
- Words like "kids", "primary", "secondary" or "adult" are used only when no exact age is given, and use the **oldest** age of their range.

**Teen and adult signals** push kid-themed games down:
- teen, secondary, Form/S/F/中 N, adult, 成人, DSE, IELTS
- an exact age of 13 or more
- "teenage" counts as a teen signal
- business, 商業, 商務, and "work", except in homework, group work, pair work, worksheet, "work on" and "work in groups"
- office, 上班, 返工, 職場 and 工作 (not 工作紙, worksheet)

Exception: when the teacher states an age under 13, "business" and "work" do not count. So "9 year old business game" still gets Mini Business Tycoon Junior.

### The answer

**Number of games.** Under 30 minutes gives 1–2 games; 30 minutes or more gives 2–3; no length given gives up to 3. "1 hour 15 min" and "1小時15分鐘" count as 75 minutes. Lengths in words work too: "forty-five minutes", "四十五分鐘", "two hours", "個半鐘" (90) and "quarter of an hour" (15).
- The lesson length and phrases like "first time" are never matched as topics, so "30分鐘" does not bring up Telling the Time.
- If the strong matches run out, the gap is filled in this order:
  - the next games of the same skill that pass the filters
  - other matching games
  - classroom tools
- Games of the asked-for skill always come before keyword matches from other skills.
- When two games score the same and the question is about teens, adults or work, the game written for older learners goes first ("工作英文" gives Ladder Talk before Community Helpers).

**What counts as a match:**
- 口說 (the site's tag) and 口語 (what many teachers type) are the same word. The catalogue uses both, so either one matches games tagged with the other, and the answer does not depend on which is typed.
- School years in a game's keywords (P4, 小四, 中一, 中學) count only a little and never as the topic: the age filter already uses them. So "中一 商業英文" gets Ladder Talk, not Ladder Vocabulary.
- "group work", "work on", "worksheet" and 工作紙 are not the topic "work".
- **One keyword match is enough** when the message mentions English or teaching (English, ESL, teach, tutor, 英文, 英語, 教, 補習, 練) or a learner (an age, a level, "adult", 學生…) and nothing else but filler: "English for work" and 職場英文 give Ladder Talk and Ladder Frames; "我學生 6 歲，想練自我介紹" gives Intro Builder. "class", "lesson" or "practice" alone are not enough, so "Where is my cooking class?" stays off-topic. Anything else needs a stronger match.
- **No sign of a lesson, no games.** A message with no skill, age, level, lesson length, learner word or teaching word gets the off-topic reply, whatever keywords it hits. So "Book a meeting room in the office for Monday" stays off-topic although Ladder Talk has the keywords meeting and office. Of 132 off-topic test messages, 3 now get games, all with an adult word ("My adult son works in an office now"); 9 that used to get games no longer do.

**Free game first.** A free game goes first when all of these hold:
- it passed the filters
- it matches the query's topic, not just a word like "adult" or "kids"
- it scores at least 60% of the best game

This applies in both modes. In AI mode, if the model leaves it out, the widget puts it in.

**Ladder Vocabulary** takes one card, with a button for each level that fits the age and any stated level. For example, a P5 student gets A1 · A2 · B1, and "A2" gives only A2.

**When the widget asks instead of answering:**
- **An age, grade or level with no skill** ("Form 4 student", "Form 4 students", "中四生", "Any ideas for a Form 4 student?", "Got anything for a 10 year old?", "請問有冇適合K2嘅遊戲？", "我聽日教個小三學生，有咩好玩？", "Adult, B2", "6歲 beginner"): one question, "Which skill?", with numbered choices 1) Speaking 2) Writing 3) Grammar 4) Vocabulary 5) Phonics 6) Listening, or 1) 口說 2) 寫作 3) 文法 4) 詞彙 5) 拼讀 6) 聽力 in Chinese, the same words as the site's skill tags. This happens only when the rest of the message is teaching words. "My 8 year old wants a pizza recipe" still gets the off-topic reply.
- **Reading** (reading, 閱讀, 睇書, 看書; 讀書 about going to school, as in "喺國際學校讀書", does not count):
  - Under 8, reading means phonics.
  - From 8, the widget says there is no reading game yet and offers 1) Vocabulary 2) Grammar 3) Listening.
  - If the age range crosses 8, the youngest age decides.
  - With no age, it asks the age first.
- **No game of that skill for this age** (e.g. "5 year old grammar"): it says so, for example "Grammar games start at age 8", and offers the skills that do have games.

**Kid-themed games for teens and adults** ("adult business english", "teenager, money"; all four Money English games are kid-themed):
- A game that isn't kid-themed goes first: the best keyword match, otherwise a game whose catalogue text is about older learners, free first.
- The line "No Money English game is designed for teens or adults yet. These are kid-themed:" appears before the kid-themed cards whenever their skill has no game for older learners. It never names a skill that does have one.
- Then the kid-themed games: those of a skill with nothing for older learners first, then older ones first.

Today: "adult business english" and "商務英文 上班族" give **Ladder Talk**, the note, then Mini Business Tycoon Super and Young Entrepreneur. "English for work" and 職場英文 give Ladder Talk and Ladder Frames. Ladder Frames matches work, job, 求職 and 職場, but not "business" (its keywords don't have it).

**Follow-ups** ("any other recommendations", "more", "another one", "something else", "Is there anything else?", "something new", 還有其他推薦嗎, 仲有冇, 其他, 更多, 有冇第二個, 悶…), with no new age, level or skill: the previous question again, without any game already shown in this conversation.
- A new lesson length may come with it ("another one for 20 minutes", 仲有冇其他 20分鐘) and is used.
- When nothing is left, the widget says "No more games fit that. Try another skill:" with numbered choices of the skills that still have games for this learner. Picking one shows that skill's games, still without repeats. If no skill is left either: "No more games fit that yet."
- After a question from the widget ("Which skill?") a follow-up asks it again; after "no game for this age" it says nothing is left. It never goes back to an older question.
- A follow-up is never answered with "could not match"; as a first message it gets "Which skill?".
- Not follow-ups: "No more, thanks", "Thanks again", "hello again", "next week" (the off-topic reply, as before).

**Short answers join the previous question.** A digit, a chip, or a reply that only gives an age ("she's 9", "9", "nine", "九", "佢今年九") or only gives a skill is added to the earlier question. A new full question starts fresh.
- Games shown without an age come with the age buttons. Typing an age instead ("7", "she's 7", "7歲") also joins the earlier question. A reply with its own topic ("我學生 6 歲，想練自我介紹") is a new question.

### AI mode

1. The questions above, off-topic messages and "no game for this age" are decided by the keyword rules and never reach the model.
2. The best 12 games that pass the filters go to the model as candidates. Each candidate carries `age_min`, its level range and `kid_theme`, but no URL or price.
3. WebLLM's grammar engine forces a JSON reply: `{"picks": [...]}` using candidate ids only, as many as the lesson length allows. It can reply `{"ask": "..."}` only when the teacher gave neither age nor level.
4. The widget then validates the picks and applies the same post-processing as keyword mode, in this order:
   - **the keyword answer's lead stays first**: its first card (whatever it matched by), and its best keyword match when a free game went in front of it. The model fills the other places but cannot drop or demote them. (This fixed the three AI failures in the owner's run: Number Ninja, Clinic Day and IELTS Speaking Room, and Ladder Talk for "adult business english".)
   - hard filters
   - top up: never fewer cards than the keyword answer ("Year 5 口說" gives three even when the model returns one)
   - kid-themed games down
   - free game first
   - trim to the maximum
   Follow-ups send the model only games not shown yet.
5. A model question is never shown as written: the widget shows its own "How old are they?" with age buttons.
6. Bad output falls back to keyword matching. So does a crash, a timeout (45 s) or a failed download, for the rest of the visit, and the teacher's text is kept.

The system prompt in `src/ll-assistant.js` (`SYSTEM_PROMPT`) is the one you specified, unchanged.

### Language

One language per conversation. It changes only when a message has Chinese characters or at least two English words, so answering "2", "B1" or "DSE" keeps it. When it changes, every earlier answer is redrawn in the new language. Plan labels:
- English: Free / Parent / Teacher
- Chinese: 免費 / 家長版 / 老師版

---

## Look and feel

**Colour budget:** ink, cream and white carry the widget. Colour appears only in:
- the plan label, the only coloured pill on a card (the library page's `.tier` rule: free `--tier-free`, parent `--yellow`, teacher `--purple-1`, ink text)
- the yellow focus ring (`0 0 0 4px var(--yellow)`, keyboard focus only, the ink border stays)
- the teacher's message bubble: `--teal-pale` with `--ink` text, on the right
- the coral gradient, on exactly one element: the enabled **Find games** button (site CTA: ink text, 3px ink border; disabled: `#E5E7EB` background, `--ink-soft` text, `#9CA3AF` border, no shadow)

No border is ever coral or red, in any state. Tests check every element's computed colours at rest, on hover, on keyboard focus and while pressed.

**Parts:**
- **Header:** the title on one line, the lock sentence (13px, normal weight, balanced lines), a 1px line under it. "AI suggestions can be wrong." appears as small text under each reply that came from the model.
- **Result cards** copy the library game card: white, 3px ink border, `--r-md`, `--sh-rung`; they lift on hover and keyboard focus. The title is ink (Fredoka 600) with ↗, underlined on hover. Under it: the plan label and one plain `--ink-soft` line, for example "Speaking · Teacher-led · Level A2 · Kid-themed". Paid cards add "Opens the plan details" / 「會開啟方案詳情」. Descriptions show three lines, then a "more" toggle, never an ellipsis.
- **The whole card opens the game.** The title stays the single button; its click area is stretched over the card, so there is one tab stop per card (plus "more"), the screen reader name is the game title, and the focus ring is drawn on the card. "more" sits above the click area and never opens the game.
- **Buttons and chips:** white pills with an ink outline. Chips copy the library `.chip` (2.5px ink, Fredoka 600; lift and `--sh-rung` on hover). The launcher, Download and Cancel buttons are the same white pill with `--sh-rung`.
- **AI offer:** once the first message is sent without a choice, it shrinks to one line ("Use on-device AI (… MB)"), so the answers keep the room; that line opens it again.
- **Composer:** one white box with a 2.5px ink border; the text box (no border of its own) and the Find games button sit inside it, the button centred on one line and bottom-aligned when the text grows. The text box starts at one line and grows to four. Placeholder "Age, level, skill" / 「年齡、程度、技能」 (fits at 320px). Its own label, "Describe your student", is visually hidden. The focus ring is on the box.
- **Conversation:** each teacher message and its reply form one group: 8px inside, 24px and a 1px line between groups; cards 8px apart. The intro and example chips are the empty state only. Thin scrollbar.
- **Progress bar:** 12px, ink on the line colour (teal is outside the colour budget).
- **Screenshots** at 320, 375 and 1280px with the site fonts are written to `tests/results/screenshots/` by `npm test`.
- **Fonts:**
  - headings use `--ff-head` (Fredoka), body text `--ff-body` (Nunito), with Noto Sans HK for Chinese
  - the widget downloads no fonts itself
  - Chinese headings are weight 700 with 0.02em letter spacing
  - the text box and the teacher's own bubble use system fonts only: Google Fonts serves Chinese in character ranges, so a web font there would fetch files based on the characters typed
- **The demo page** loads no fonts and no tokens by default, which keeps the automated tests free of outside requests. Use `demo.html?site=1` to see it with `ll-tokens.css` and the site's Google Fonts.

---

## Privacy and analytics

**Header:** "Runs in your browser. What you type is not sent to us." / 「喺你部機運行。你打嘅內容唔會傳送畀我哋。」 Under each reply from the model: "AI suggestions can be wrong." / 「AI 建議可能有錯。」 (The keyword-mode line "Matches by keyword." is gone: the header now has the title and the lock sentence only.)

**What leaves the device:**
- There is no server. The widget's code sends nothing the teacher types, and nothing worked out from it, anywhere. The Clarity and Google Fonts notes below describe what other scripts and the browser itself can see.
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
| `ll_game_click` | A result card or level button is clicked, once per click, before the hand-off below | same pattern | same pattern |

- The only parameter is `event_category: "ll_assistant"`. No query text, no game id, no plan, no language.
- GA4's own script adds its standard fields to every event (page URL, referrer, page title, browser language, screen size, its client and session ids). That is normal page analytics, not data from the conversation.
- The widget has no `<form>`, so GA4's automatic form events never fire from it.
**Opening a game: the widget hands the click to the page.** It never sends anyone to a paid game itself.
1. On the library page, it clicks the library's own card for that game (`a.card[data-title="<exact title>"]`) and does nothing else. The library decides: free games open, locked games show the site's lock pop-up with the buy button, members who own the game go straight in.
2. On any other page: a free game opens at `location.origin + path`; a paid game goes to `location.origin + "/library"`.
3. Addresses are always built from `location.origin`, so the same file works on ladderlessons.com and app.ladderlessons.com. A paid game's public address (which shows "you have been blocked") is never used. Tests run on both origins.

**Privacy of the hand-off, stated plainly:** when the widget clicks a library card, the library's lock pop-up shows the game title and sends **its own** analytics events (`ll_lock_view` and others) **with the game title**. That is the library's existing behaviour, outside the widget. It means the site can see which locked game was opened from the widget, still nothing the teacher typed. Opening a free game is a normal page visit, which your analytics count like any other.

**Microsoft Clarity (decision 7B: keep recording, remove every clue):**
- The widget's root has `data-clarity-mask="true"`, so Clarity hides all text inside it. Clarity only checks that this attribute is present; the value doesn't matter.
- Typing events stop at the widget, before Clarity's listeners or any other page script: input, change, all key events, the browser's before-input and text-input events, Chinese input-method events, text selection in the text box, and cut, copy and paste. This matters because without it, Clarity uploads an encoded fingerprint (a hash) of the typed text when the text box loses focus. The browser tests run the real Clarity library to confirm the fingerprint no longer appears.
- Games open from buttons, not links, so the widget's own click records carry no game address.
- **But on the library page the widget clicks the library's own card** (see "Opening a game" above), and Clarity records that click like any click on the card: with the card's text (the game title) and its link (the game path). This happens in mask mode and also in pause mode, because Clarity's pause only holds back processing; it still records clicks on the page outside the widget, including the library's lock pop-up. So Clarity can see which game was opened from the widget on the library page, still nothing the teacher typed.
- The widget's page code holds no game ids, sources or `lang` attributes. Plan colours come from a one-character code (`data-t="1|2|3"`), and class names never name a game, plan, skill or language.
- Class names are the same for every kind of answer.
- **What Clarity still records:**
  - where clicks, mouse movement and scrolling happen inside the widget
  - the character count of each masked text, such as a card title or description
  - the page structure: how many cards, tags and buttons each answer has
  - where text is selected inside the widget (which element and the position, not the text)

  Someone could match those counts against the catalogue to guess which games were shown. Typing itself is not recorded: input, change and key events never reach Clarity.
- **For a stronger guarantee, add `data-clarity="pause"`** to the script tag:
  - Clarity pauses while the widget is open.
  - Every mouse, pointer, touch, scroll, focus, drag, click and text-selection event inside the widget also stops before Clarity's listeners. The buttons still work, because the widget runs them itself.
  - On close, any text selected inside the widget is deselected before Clarity resumes.
  - On close, the conversation is cleared from the page and kept in memory. An answer that finishes after close is not drawn until the widget reopens. The send button and labels reset to the page's language before Clarity resumes.
  - Clarity then sees nothing inside the open widget except that the launcher was clicked. Clicks the widget hands to the library's cards are page clicks and are still recorded (see above).
- **After deploying, check both GA4 and Clarity:**
  - **Clarity:** open the widget in an incognito window, type a message and click a game. Find that session in Clarity and confirm the widget area shows masked blocks only, with no typed text. On the library page the click on the library card shows the game title and path, as described above.
  - **GA4:** in DebugView, confirm a game click shows only `ll_game_click`, with no automatic `click` event carrying a `link_url`.
- **Google Fonts:** the site loads Noto Sans HK from Google Fonts in character ranges, and the browser fetches only the ranges for characters on screen.
  - When the widget shows Chinese labels, game titles or descriptions, Google can see which character ranges were needed. That roughly reflects which games were shown.
  - It never covers the characters the teacher types, because the text box and the teacher's own bubble use system fonts.
  - Rendering card text in system fonts too would close this. It would change decision B2, so I have not done it.
- The widget never asks for a name, an email or anything about a specific child. It makes no security or certification claims.

**Escape key:** Escape closes the widget when focus is in the widget or on the page itself. Escape in one of your page's own fields, such as a search box, is left to your page and the widget stays open with its draft. Focus goes back to the launcher only if it was in the widget.

---

## The model

| | |
|---|---|
| Model | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` (Qwen2.5 0.5B Instruct, 4-bit) |
| Licence | Apache 2.0 (Qwen2.5-0.5B-Instruct) |
| Download | **277 MB measured** in the browser cache on the owner's Mac. The button said 270 MB: its estimate (weights + tokenizer + runtime, read from the model host) is about 7 MB short. Not fixed yet. |
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
- `tests/questions.json` has 160 fixed questions in English and Chinese. They cover every failing case from the test round plus every review round's edge cases:
  - kids, adults, IELTS, DSE and Form 4
  - phonics, reading and vocabulary levels
  - lesson lengths, in digits and in words
  - ages without a unit, number-word ranges, university years, F1 racing, "studied English 3 years"
  - request phrasings with an age but no skill
  - business and work English (Ladder Talk expected), self-introduction, group work and 工作紙 for kids, 返工
  - follow-ups in both languages (`after` = the message before; `newOnly` = no game repeated), including "nothing left"
  - "Year 5 口說" / "Year 5 speaking" with three games
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
- **The real model's replies:** `tests/fixtures/model-replies-2026-10-06.json` holds the 94 replies Qwen2.5-0.5B gave on the owner's Mac. Replaying them through the old code gives exactly the owner's 119/122; through the current code, 122/122.
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
   - card names, plan label wording and colour, the plain meta line, the plan note on paid cards, no other coloured element
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
4. **`data-clarity="pause"`:**
   - paused while open, and no widget event reaches page-level listeners: typing, keys, Chinese input, select, cut, copy, paste, clicks, mouse, touch cancel, drag, text selection and scroll. Each event is also counted before the widget, so the test proves it really happened.
   - no selection is left inside the widget after close
   - the conversation is cleared before Clarity resumes
   - an answer arriving after close is not drawn
   - the send button resets
   - in mask mode, clicks still reach Clarity but typing, keys, selection in the text box and the clipboard never do
5. **Language:** one language per conversation, earlier answers redrawn, "2" keeps Chinese.
6. **Choices:** skill question, reading and "no game for this age" answered by click.
7. **Narrow screens** (320, 375 and 768 px wide): panel fits, no sideways scroll, input and button on one row.
8. **Review-round fixes:**
   - a failed catalogue load survives a language switch and is retried
   - "she's 9", "nine", "九" and "佢今年九" answer the age question
   - a typed age after games shown without an age joins the earlier question; a new question does not
   - Escape in a page field leaves the widget open with its draft; Escape on the page or in the widget closes it
10. **Look:** coral, gradient and border colours of every element at rest, hover, focus and pressed; 3px ink card borders; chips; teal-pale bubble; composer, header, grouping and scrollbar rules; first card fully visible at 375px.
11. **Cards and hand-off:** the description area opens the game, "more" does not, one control and one event per card; host card click for paid (lock pop-up, no navigation) and free; /library without a host card; no ladderlessons.com address for a paid game; all on 127.0.0.1 and on app.ladderlessons.com.
12. **Follow-ups** in English and Chinese, the "nothing left" reply, a skill picked after it, a follow-up after the widget's own question, and "no skill left".
14. **Fourth review round:** the yellow ring while the pointer is over a button or chip, card titles Fredoka 600 in Chinese, the Ladder Vocabulary card lifts, the AI offer shrinks after the first message so the first card stays in view, descriptions measured again after a rotation, and a lock pop-up that fades out does not leave the widget hidden.
13. **Screenshots** at 320, 375 and 1280px (empty, a reply with three cards, a follow-up, the text box focused).
9. **Device and download:**
   - no `navigator.gpu`
   - phone and in-app user agents
   - simulated GPU: size shown, nothing before the click, failed download falls back
   - cancel
   - fake-model AI path, including crash
   - cached second visit

### Before and after (E3)

**Keyword mode:** `npm run compare` runs the old code (commit fb82fd2, kept in `tests/baseline/`) and the new code on the same questions with the same checker. Result: **before 49/159, after 159/159**. Full table: `tests/results/keyword-before-after.md`.

**AI mode, owner's run (2026-10-06, Mac, Apple GPU, Chrome 154, 122 questions):** before 34/122, after 119/122, 0 invalid replies or crashes in 94 model calls. The three failures (Number Ninja, Clinic Day, IELTS Speaking Room dropped or demoted by the model) are fixed by keeping the keyword answer's lead; the replay of those same 94 replies now passes 122/122. The 24 questions added since need a new run of `model-test.html` to have real model replies.

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
| Desktop Chrome on macOS | **AI** | **Yes, on real hardware**: owner's Mac (Apple GPU, metal-3, 32 GB), Chrome 154. 94 model calls, 0 invalid | |
| Desktop Chrome / Edge (Windows, ChromeOS), recent version | **AI offered** on most GPUs | Not on real hardware. Offer, download, cancel and fallback tested with a simulated GPU | Needs WebGPU with `shader-f16` |
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
| Page-load cost | 2 requests: `ll-assistant.js` 32 KB gzip + `ll-assistant.css` 4 KB gzip. Layout shift 0. **Measured** in headless Chromium |
| Model download size | **277 MB** (289,982,565 bytes), **measured** in the cache on the owner's Mac. Download time not measured (the model was already cached) |
| Model start from cache | **985 ms**, measured, owner's Mac (Apple GPU, Chrome 154) |
| Time to first answer | **641 ms**; median answer **495 ms**. Measured on the owner's Mac, not a mid-range laptop |
| Page memory (JS heap) | **47 MB**, measured, owner's Mac |
| GPU memory | ~945 MB is **WebLLM's published estimate, not measured** |
| Model speed (tokens/sec) | The owner's run showed `NaN`: the worker reset the chat after each answer, which cleared WebLLM's counters. Fixed: it now averages the speed WebLLM reports with each answer. Needs a new run |

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
tests/fixtures/              the real model's recorded replies, replayed by the unit tests
tests/results/               before/after table and screenshots, written by npm test
```

`dist/` is committed so the folder can be copied without running Node. After editing `src/`, `catalogue.json`, `ages.csv` or the CSV, run `npm run build` and commit `dist/` too.
