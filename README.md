# Ladder Lessons game finder

A small widget for ladderlessons.com. A teacher types who they are teaching (age or level, skill, lesson length) and gets a lesson plan of 1 to 3 games from the catalogue: warm-up, main activity and wrap-up (or one game split into its own parts), with suggested minutes when a length is given. Each game has a card that opens it, a plan label (Free / Parent / Teacher) and a Teacher-led or Student-solo tag. The plan can be sent to the teacher's laptop.

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

Then open **http://localhost:8080/** in Chrome. It goes straight to **the page to test: `demo.html?site=1`**, the widget with the site's fonts (Fredoka, Nunito, Noto Sans HK) and colours. Without `?site=1` the demo page loads no fonts, so card titles show in a system font; that is why screenshots from `http://localhost:8080/` used to look different.
- Keyword mode: `http://localhost:8080/demo.html?site=1&llai=off`
- The site's email form for "Send this plan" (a stub): `http://localhost:8080/demo.html?site=1&host=1`
- The model test: linked from the demo's test controls (`tests/model-test.html`)
- A plan link goes to `/library#llplan=…`. `npm run serve` serves the demo page at `/library`, so those links work locally. With `python3 -m http.server` they don't: replace `/library` with `/demo.html` in the address.

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
| `ll-assistant.js` | 12 KB (4.6 KB) | Page load, `defer`. Only the button, the guards that keep typing away from page scripts, `data-avoid` and the plan-link check |
| `ll-assistant.css` | 18 KB (5 KB) | Page load, added by the script |
| `ll-assistant-app.js` | 147 KB (48 KB) | The first time the teacher opens the widget: the finder itself (matching and the English-Chinese word list, the lesson plan, sending the plan, the AI offer, the conversation) |
| `catalogue.compact.json` | 43 KB (17 KB) | The first time the teacher opens the widget |
| `ll-worker.js` | 3 KB | Only after the download click, or when the model is already cached |
| `vendor/web-llm.js` | 6.3 MB (2.2 MB) | Only after the download click, or when the model is already cached |
| `vendor/web-llm.LICENSE.txt` | | Apache 2.0 licence for WebLLM. Keep it with the library |

Deploy the files together. In `dist/`, `ll-assistant.js` loads the finder as `ll-assistant-app.js?v=<content hash>`, so a cached button script never pairs with a finder it was not built with. While the finder loads on the first click the button is marked busy; if it cannot load, the button says "Try again" / 「再試一次」 and the next click tries again.

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
| `ages.csv` | Per game: `age_min`, `age_max`, `level_min`, `level_max`, `kid_theme`, `parts` (the game's own sections, in screen order, separated by " \| "). `parts_basis`, `prefill_basis`, `your_notes` and `description_en` are notes for you and are not used | You |
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
  - a part name that is empty or appears twice in one game
  - a `path` that does not start with `/`, or a paid game marked `in_public_build`
- Unit tests check that the compact file matches `catalogue.json` and `ages.csv` exactly.
- The compact file has each game's `path` and a flag for the 4 public (free) games. It has **no absolute address**: `url` and `app_url` are not copied, so the widget cannot link a paid game to ladderlessons.com.

**How the widget uses the data:**
- **age_min is a hard filter.** A game is dropped when the student is younger than `age_min`. There is no upper age limit, because adult beginners use the same games, so `age_max` is kept in the file but never used.
- **Levels are a hard filter only when the teacher states a level.**
  - Codes: A1 to C2.
  - Words: beginner = pre-A1/A1, elementary = A1/A2, pre-intermediate = A2, intermediate = B1, upper-intermediate = B2, advanced = B2/C1.
  - A game with no level data always passes.
- **kid_theme = Y is a ranking signal, never a filter.** For teen, adult, exam and business queries those games go below all others, never first (also in the lesson plan: never Main, never the warm-up), and get a **Kid-themed** tag.
- **"How to run it" appears only for games that have their own line** in `teacher-fields.csv`. Every card says Teacher-led or Student solo on its plain meta line.

Ladder Talk's `age_min` is 10 (changed from 16 because teen topics were added). Grammar Detective's `age_min` is 10 (from 8), so 「小三 文法」 and "Year 3 grammar" no longer get it.

**Parts** (37 of 67 games) are used only by the lesson plan. A blank `parts` cell means not known: that game is never split into steps. Tense Studio's part order is your guess (noted in the CSV); the widget shows it as written.

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
- office, boss, colleague, 上班, 上班族, 返工, 職場, 工作 (not 工作紙, worksheet), 開會, 會議, 同事, 老闆 and 上司: work words without 商務. "My boss's son is 7" and 我老闆個女 are about a child, not about work.
- exam words (exam, test prep, KET, FCE, 考試, 測驗), "middle school", "junior high", "high schoolers", "uni", and a school word whose age starts at 12 or more

Exception: when the teacher states an age under 13, "business" and "work" do not count. So "9 year old business game" still gets Mini Business Tycoon Junior.

### The answer

**Number of games.** Under 30 minutes gives 1–2 games; 30 minutes or more gives 2–3; no length given gives up to 3. "1 hour 15 min" and "1小時15分鐘" count as 75 minutes. Lengths in words work too: "forty-five minutes", "四十五分鐘", "two hours", "個半鐘" (90) and "quarter of an hour" (15).
- The lesson length and phrases like "first time" are never matched as topics, so "30分鐘" does not bring up Telling the Time. Nor is "first lesson", "next class" or "every week" (round 7): "first" there says which lesson, so 「kids first lesson, grammar」 no longer brings up Conditional Studio ("first conditional"), and "adults, first lesson" asks for the skill like "adults, lesson". "adults, first conditional" still finds Conditional Studio.
- If the strong matches run out, the gap is filled in this order:
  - the next games of the same skill that pass the filters
  - other matching games
  - classroom tools
- Games of the asked-for skill always come before keyword matches from other skills.
- When two games score the same and the question is about teens, adults or work, the game written for older learners goes first ("工作英文" gives Ladder Talk before Community Helpers).

**What counts as a match:**
- **One meaning, two languages.** `CONCEPTS` in `src/ll-assistant-app.js` is a short list of word groups that mean the same thing in English and Chinese: skills (speaking = 口說 = 口語 = 口試, tenses = 時態, proofreading = 改錯 = 校對, vocabulary = 生字 = 詞彙…), learners (kids = 小朋友 = 細路 = 細路仔 = 小孩, student = 學生, adult = 成人…), school stages (Form 2 = F2 = S2 = 中二, P3 = 小三, secondary = 中學), work (work = office = 上班族 = 返工 = 職場; boss = 老闆 and colleague = 同事 and meeting = 開會 = 會議, each also meaning work; job = 職業 = 求職 = 工作面試), festivals, and a few classroom and everyday words (warm-up = 熱身, group = 小組, doctor = 睇醫生…). A teacher's word and a game keyword in the same group are one match, counted once, whichever language either is in; a Chinese keyword that contains a group word (切音節, 小組面試, 商業英文) belongs to that group. Every group gives the same skill in both languages (a unit test checks this). So a question and its translation get the same games in the same order: "Form 4 student speaking" and 「中四學生 口說」 both rank Quick Fire Flashcards, Festival Speaking Builder, Ladder Talk, and both plans show Ladder Talk as the lesson with the other two under "Other games that fit" (a festival game is not Main without a festival in the question; see the lesson plan). A test runs 22 such pairs. Words not in the list still match as typed.
- A Chinese group word inside a longer word with another meaning does not count: 新年度 (new school year) is not 新年, 超過年半 is not 過年, and 最高級 (superlative) is not the level 高級.
- **Everyday uses of skill words** ("let's talk", "a few words", "quick question") do not count when the message also asks for a skill properly ("needs grammar").
- **Letters are phonics:** alphabet, 字母 and 認字母 point to phonics. ABC does only next to a "cannot yet" or learning word (唔識, 不會, 還沒, 還未, 未識, 認得, can't, don't know, learn, recognise), so 「6歲小朋友，ABC還沒認得」 and 「細路 唔識ABC」 give Ladder Phonics first, while "I work at ABC Bank" and 「ABC公司 開會」 stay off-topic and "ABC Primary School, P3 vocab" gets vocabulary games.
- **Festivals:** 聖誕, 聖誕節, 萬聖節, 萬聖, 復活節, 中秋, 新年, 過年, 農曆新年, 篝火之夜 and 節日 (and English "New Year" and "trick or treat", each read as one phrase) each also mean "festival", so they find Ladder Festivals. A test checks that every festival named in a festival game's English keywords and description (Christmas, Easter, mid-autumn, mooncake, bonfire night) has a Chinese word that finds it; 新年, 農曆新年 and the other Chinese words are checked separately. **Halloween:** Ladder Festivals' keywords in `catalogue.json` now include Halloween, 萬聖節, 萬聖 and "trick or treat" (owner's decision, round 6). Tests check them in keyword mode (`&llai=off`) and in AI mode with scripted and fake models, which may leave the game out: it stays first. With a skill named too (「8歲 萬聖節 口說」, "Halloween speaking"), the festival game for that skill leads instead (round 7, below).
- School years in a game's keywords (P4, 小四, 中一, 中學) count only a little and never as the topic: the age filter already uses them. So "中一 商業英文" gets Ladder Talk, not Ladder Vocabulary.
- "group work", "work on", "worksheet" and 工作紙 are not the topic "work".
- **One keyword match is enough** when the message mentions English or teaching (English, ESL, teach, tutor, 英文, 英語, 教, 補習, 練) or a learner (an age, a level, "adult", 學生…) and nothing else but filler: "English for work" and 職場英文 give Ladder Talk and Ladder Frames; "我學生 6 歲，想練自我介紹" gives Intro Builder. "class", "lesson" or "practice" alone are not enough, so "Where is my cooking class?" stays off-topic. Anything else needs a stronger match.
- **No sign of a lesson, no games.** A message with no skill, age, level, lesson length, learner word or teaching word gets the off-topic reply, whatever keywords it hits. So "Book a meeting room in the office for Monday" stays off-topic although Ladder Talk has the keywords meeting and office. Of 132 off-topic test messages, 3 now get games, all with an adult word ("My adult son works in an office now"); 9 that used to get games no longer do.

**Several skills in one message** ("Form 2學生想練tenses、生字跟文章改錯", "Age 9, speaking and listening", 「8歲 文法 生字」): each part between commas, 、, "and", 跟 or 同 that names a skill is one request; inside a part, words of different skills separated by spaces are one request each. The widget picks the best game for each request first (scored on that part of the message only; a free game of that skill goes first when it matches as well, as below), then fills any place left. That first message gives Tense Studio, Ladder Vocabulary and Grammar Detective. A part that only names a skill (練口語) next to a more specific request of the same skill (升中面試) counts once.

**Free game first.** A free game goes first when all of these hold:
- it passed the filters
- it matches the query's topic, not just a word like "adult" or "kids"
- it scores at least 60% of the best game

This applies in both modes. In AI mode, if the model leaves it out, the widget puts it in. In the lesson plan it becomes the warm-up, or, when the Main game is split into its parts, the first of "Other games that fit".

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
- Not follow-ups: "hello again" and "next week" (the off-topic reply, as before).

**Small talk** (owner's decision: a polite reply at any time, not only after a question): "thanks", "ok", "Great, thanks!", "No more, thanks", "Thanks for your help", 多謝, 唔該, 唔該晒，我遲啲再試, 好的, 收到 get a short polite reply ("You're welcome. Ask me again any time." / 「唔使客氣，有需要再問我。」; for ok: "Sure. Ask me again any time." / 「好，有需要再問我。」). They never repeat the widget's last question and never count as its answer: after "Which skill?", "thanks" leaves the question open. A message with a number or a request in it ("8 thanks", "thanks, age 8 phonics") is not small talk.

**Short answers join the previous question.** A digit, a chip, or a reply that only gives an age ("she's 9", "9", "nine", "九", "佢今年九") or only gives a skill is added to the earlier question. A new full question starts fresh.
- Games shown without an age come with the age buttons. Typing an age instead ("7", "she's 7", "7歲") also joins the earlier question. A reply with its own topic ("我學生 6 歲，想練自我介紹") is a new question.

### The lesson plan

Every answer with games is shown as a lesson plan, heading **Your lesson plan** / 「你嘅課堂安排」. Nothing the teacher typed is in it except the lesson length. All of it is built in code from the catalogue; in AI mode the model only picks the games.

1. **Main activity** = the game with the highest score after every filter. For a teen, adult, exam or business question it is never kid-themed. **Festival games** (games whose keywords are festivals: Ladder Festivals, Festival Speaking Builder) are never Main, and never a step at all, unless the question names a festival or says 節日/festival; they appear only under "Other games that fit". So "Form 4 口說" and 「中四 speaking」 get Ladder Talk as the lesson, while 「Form 4 中秋節口說」 still gets the festival games.
   **Festival and skill (round 7, owner's rule):** when the question names a festival (or 節日/festival) and a skill (口說, writing…), Main is the festival game most about that skill, and it is also the first card and part of the AI lead. With several skills named (「中秋節口說同聆聽」), it is that skill's card. An everyday word ("let's talk about Christmas") does not name a skill. "Most about the skill" is counted from the catalogue only: 1 for the game's skill, plus 1 for each of its keywords and title words that names the skill (`SKILL_WORDS`). Festival names and other topic words do not count, so the game that lists the most festivals does not win on that. Today: Festival Speaking Builder 3 (speaking, 口說/speaking, "Speaking" in its title), Ladder Festivals 2 (speaking, 口說/speaking). So 「Form 4 中秋節口說」, "Form 4 Mid-Autumn speaking", "Halloween speaking" and 「8歲 萬聖節 口說」 get Festival Speaking Builder as the lesson and Ladder Festivals under "Other games that fit". No game name is written in the rule: a unit test adds a made-up festival writing game to a copy of the catalogue and 「10歲 中秋節 寫作」 picks it; with Festival Speaking Builder removed, 「Form 4 中秋節口說」 falls back to Ladder Festivals. When no festival game fits the skill (寫作 and 聆聽 today), or no skill is named, the usual order decides, as before: 「中秋節遊戲」 gets Ladder Festivals.
2. **Main has 2 or more parts** (from `ages.csv`) → **single-game plan**: that game is the lesson, as one card, and its parts are the steps, in order.
   - At most 4 steps. A game with more parts gets parts 1 to 3, then one step 4 with the rest joined by " + ", in order ("Practice + Real Life"). No part name is dropped.
   - Part names stay in English in Chinese answers, as on the game's screens.
   - With a length: split evenly in 5-minute blocks, at least 5 minutes a step, adding up to the length (45 minutes over 4 parts: 15, 10, 10, 10). A length too short for every part gives fewer steps, the last parts joined the same way.
   - **Other games that fit** / 「其他啱用嘅遊戲」: up to 2 more cards, free first.
   - Summary: "This game is free." or "This game is in the Teacher plan."
3. **Otherwise, a multi-game plan:**
   - 3 games: Warm-up / Main activity / Wrap-up (暖身 / 主要活動 / 總結); 2 games: Warm-up, Main activity; 1 game: no label.
   - Warm-up = a free game if there is one besides Main, otherwise the next highest score. Wrap-up = the game left.
   - Minutes only when a length was given, labelled **Suggested timing** / 「建議時間」: 20/60/20 or 30/70, warm-up and wrap-up rounded to 5 (halves down), Main takes the rest, so the steps add up to the length (30 min: 5/20/5; 45: 10/25/10; 25 min, 2 games: 5/20). When the length cannot give every game 5 minutes, the wrap-up (then the warm-up) moves to "Other games that fit".
   - Summary, counted from the catalogue: "You can run step 1 today, free." / 「第 1 步今日就玩得，免費。」 and "2 of 3 steps are in the Teacher plan." / 「3 步入面有 2 步喺老師版。」 (the higher plan is named when both appear; "All 3 steps are in the Parent plan." when none is free). Every step free: the first line only.
4. Each step is a full card: the whole card opens the game, with the plan label and the paid hand-off as before.
5. Under the plan: "Every game can be stopped at any time, so adjust as you go." / 「每隻遊戲都可以隨時停，時間可以自己調。」
6. A kid-themed note is a small line right before the first kid-themed card. For a teen, adult, exam or business question a kid-themed game is never the warm-up: when only kid-themed games are left besides Main, Main is the one step and they go under "Other games that fit", after the note.
7. Follow-ups build a new plan the same way, without games already shown.

### Send this plan to my laptop

Under every plan: a white-pill button **Send this plan to my laptop** / 「將呢堂課傳去我部電腦」. The plan stays on screen; the options open under the button.

**The link:** `location.origin + "/library#llplan=" + code`, for example `/library#llplan=m45e.writing_RolePlayWriting.writing_ChainStory.writing_DetectivesNotebook`. The code holds only: a one-letter marker (`m` multi-game, `s` single-game), the lesson length, `e` or `z` for the language, and the game ids in step order. A single-game plan's link lists its "Other games that fit" after the game; a multi-game plan's link lists them after two dots (`m30e.a.b..c`). The levels of one Ladder Vocabulary card are joined with `~`. A test fails if any word of a fixed question appears in a link.

**Opening a link** opens the widget with the plan, heading **Your saved lesson plan** / 「你儲存咗嘅課堂安排」, in the plan's language, as its own group in the conversation (any open question is closed). Unknown ids are left out; with none left, the usual empty state. The model never runs for it. The Kid-themed tags and note come back from the catalogue: in a plan that mixes kid-themed games with others, the kid-themed ones are tagged, and the note shows when their skill has nothing for older learners.

**With the site's own email form (host mode):** if the page defines `window.LLAssistantHost.sendPlan`, the widget calls it the first time the panel opens for a plan (once per plan: closing the panel only hides it, so your form, what was typed in it and "Sent" stay):

```js
window.LLAssistantHost = {
  // url:   the plan link
  // mount: an empty element under the button; put your email form in it
  // lang:  'en' or 'zh'
  // done:  call it when the email is sent (or return a Promise that resolves then)
  sendPlan: function ({ url, mount, lang, done }) { /* … */ },
};
```

Your form shows first, then a small "or copy the link" / 「或者複製連結」 line, then: "This sends your email address and this list of games to Ladder Lessons. Nothing you typed is included." After `done()` (or the Promise): "Sent. Check your inbox on your laptop." / 「已寄出，喺電腦開 email 就見到。」 If `sendPlan` throws, the panel shows the mail-app, copy and share buttons instead. `demo.html?host=1` has a stub that sends nothing.

**What your form gets and does not get:** the mount sits inside the widget, which is masked in Clarity. Clicks, focus and `submit` reach your form as usual. **Typing events do not**: `input`, `change`, key events, composition and clipboard events stop at the widget, as everywhere else in it, so no session recorder gets a fingerprint of the email address (a browser test runs the real Clarity library to check this). So read the address when the button is clicked or the form is submitted, not from `input` or `keydown` listeners. Escape in your form closes the widget.

**Without it:** three buttons, and "This uses your own mail app. Nothing is sent to Ladder Lessons."
- **Email it to myself** / 「寄畀自己」: opens the mail app with no recipient, the subject "My Ladder Lessons lesson plan" / 「我嘅 Ladder Lessons 課堂安排」, and a body with the link and one line per step with the game title. It is a button that sets the address, so no `mailto:` address sits in the page for session recorders.
- **Copy link** / 「複製連結」: says "Copied" for 2 seconds.
- **Share** / 「分享」: phones only, through the phone's share sheet.

### AI mode

1. The questions above, off-topic messages and "no game for this age" are decided by the keyword rules and never reach the model.
2. The best 12 games that pass the filters go to the model as candidates. Each candidate carries `age_min`, its level range and `kid_theme`, but no URL or price.
3. WebLLM's grammar engine forces a JSON reply: `{"picks": [...]}` using candidate ids only, as many as the lesson length allows. It can reply `{"ask": "..."}` only when the teacher gave neither age nor level.
4. The widget then validates the picks and applies the same post-processing as keyword mode, in this order:
   - **the keyword answer's lead stays first**: its first card (whatever it matched by), and its best keyword match when a free game went in front of it. When the message names several skills, the lead is one game for each. The model fills the other places but cannot drop or demote them. (This fixed the three AI failures in the owner's run: Number Ninja, Clinic Day and IELTS Speaking Room, and Ladder Talk for "adult business english".)
   - **off-topic picks left out (round 7):** for a teen, adult, exam or business question that names a topic or a skill, a model pick that matches neither (its only match is "adult", or nothing) is dropped, and it is not added back as one of the extra games of a skill. The owner's run had "adult business english" → Ladder Talk, Quick Fire Flashcards, Clinic Day: the model's Quick Fire and Clinic Day pushed the kid-themed business games, and their note, out of the three cards. It now gives the keyword answer: Ladder Talk, Mini Business Tycoon Super, Young Entrepreneur, with the note. Same rule: 「成人初學者 拼讀」 no longer shows Clinic Day, "warm-up for adults" no longer shows Clinic Day or Hook Lab. A skill counts as named only from a skill word, not from an everyday word ("talk", "words") or a head count ("6 students"). Ladder Vocabulary is judged as one card, whichever level the model names. When a pick was dropped, the keyword answer's own cards fill the place first. Children's questions are not affected (checked over 3,400 scripted runs against the version the owner ran).
   - **the keyword lead is never cut:** when there are more cards than the lesson allows, the extra ones go, never one of the lead's. Before, a kid-themed lead card (Mini Business Tycoon Super for "上班族 business english") sat below the model's picks and could be cut, with its note.
   - hard filters
   - top up: never fewer cards than the keyword answer ("Year 5 口說" gives three even when the model returns one)
   - kid-themed games down
   - free game first
   - trim to the maximum
   Follow-ups send the model only games not shown yet. The lesson plan (steps, minutes, summary) is then built in code from the result, as in keyword mode.
5. A model question is never shown as written: the widget shows its own "How old are they?" with age buttons.
6. Bad output falls back to keyword matching. So does a crash, a timeout (45 s) or a failed download, for the rest of the visit, and the teacher's text is kept.

The system prompt in `src/ll-assistant-app.js` (`SYSTEM_PROMPT`) is the one you specified, unchanged.

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
- **Header:** the title on one line with the close button on that row only; the lock sentence under them across the full width (13px, normal weight, normal line breaks: at 320 and 375px it no longer breaks after "What"); a 1px line under it. "AI suggestions can be wrong." appears as small text under the cards of each reply that came from the model, 16px below the bottom of the card shadow (the card list keeps 4px for that shadow, and the note has `margin-top: 16px`).
- **Lesson plan:** the heading in Fredoka 600 (700 in Chinese), the summary, then the step cards with a small step label ("Warm-up · 10 min") at the top of each, or one card with its parts listed under the description. The send button is a white pill; its panel is a white box. No new colours. Class names are short codes (`ll-pl-…`, `ll-sh-…`), so a session recording sees no words a teacher might type.
- **Result cards** copy the library game card: white, 3px ink border, `--r-md`, `--sh-rung`; they lift on hover and keyboard focus. The title is ink (Fredoka 600) with ↗, underlined on hover. Under it: the plan label and one plain `--ink-soft` line, for example "Speaking · Teacher-led · Level A2 · Kid-themed". Paid cards add "Opens the plan details" / 「會開啟方案詳情」. Descriptions show three lines, then a "more" toggle, never an ellipsis.
- **The whole card opens the game.** The title stays the single button; its click area is stretched over the card, so there is one tab stop per card (plus "more"), the screen reader name is the game title, and the focus ring is drawn on the card. "more" sits above the click area and never opens the game.
- **Buttons and chips:** white pills with an ink outline. Chips copy the library `.chip` (2.5px ink, Fredoka 600; lift and `--sh-rung` on hover). The launcher, Download and Cancel buttons are the same white pill with `--sh-rung`.
- **AI offer:** one line from the first open, on every screen size: "Use on-device AI (277 MB)". Tapping it opens the full offer card; "Not now" or sending a message closes it again. At 375px all three example chips are fully visible above the composer.
- **Composer:** one white box with a 2.5px ink border; the text box (no border of its own) and the Find games button sit inside it, the button centred on one line and bottom-aligned when the text grows. The text box starts at one line and grows to four. Placeholder "Age, level, skill" / 「年齡、程度、技能」 (fits at 320px). Its own label, "Describe your student", is visually hidden. The focus ring is on the box.
- **Conversation:** each teacher message and its reply form one group: 8px inside, 24px and a 1px line between groups; cards 8px apart. The intro and example chips are the empty state only. Thin scrollbar.
- **Progress bar:** 12px, ink on the line colour (teal is outside the colour budget).
- **Screenshots** at 320, 375 and 1280px with the site fonts are written to `tests/results/screenshots/` by `npm test`.
- **Fonts:**
  - headings use `--ff-head` (Fredoka), body text `--ff-body` (Nunito), with Noto Sans HK for Chinese
  - the widget downloads no fonts itself
  - Chinese headings are weight 700 with 0.02em letter spacing
  - the text box and the teacher's own bubble use system fonts only: Google Fonts serves Chinese in character ranges, so a web font there would fetch files based on the characters typed
- **The demo page** loads no fonts and no tokens by default, which keeps the automated tests free of outside requests. **Test on `demo.html?site=1`**: it has `ll-tokens.css` and the site's Google Fonts. `http://localhost:8080/` now goes there.

---

## Privacy and analytics

**Header:** "Runs in your browser. What you type is not sent to us." / 「喺你部機運行。你打嘅內容唔會傳送畀我哋。」 Under each reply from the model: "AI suggestions can be wrong." / 「AI 建議可能有錯。」 (The keyword-mode line "Matches by keyword." is gone: the header now has the title and the lock sentence only.)

**What leaves the device:**
- There is no server. The widget's code sends nothing the teacher types, and nothing worked out from it, anywhere. The Clarity and Google Fonts notes below describe what other scripts and the browser itself can see.
- No network request is made per question. The tests check this after every one of the fixed questions.
- The conversation lives in page memory only and is gone on reload.
- `localStorage` and `sessionStorage` hold nothing. (Earlier versions kept the download size as `ll-ai-bytes:<model id>`; it is no longer read or written.)
- The Cache API holds the model files.
- **Network calls happen only after the widget is opened:**
  - the catalogue, from your site
  - on capable desktops, one small file from huggingface.co (`tensor-cache.json`), to check the model host answers. The size shown is not read from it.
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
| `ll_plan_shown` | A lesson plan is shown for an answer | same pattern | same pattern |
| `ll_plan_send_open` | "Send this plan to my laptop" is clicked | same pattern | same pattern |
| `ll_plan_send_email` | "Email it to myself" is clicked, or the site's form reports the email as sent | same pattern | same pattern |
| `ll_plan_send_copy` | "Copy link" or "or copy the link" is clicked | same pattern | same pattern |
| `ll_plan_send_share` | "Share" is clicked (phones) | same pattern | same pattern |
| `ll_plan_opened_from_link` | The widget opens from a plan link | same pattern | same pattern |

- The only parameter is `event_category: "ll_assistant"`. No query text, no game id, no plan, no language.
- GA4's own script adds its standard fields to every event (page URL, referrer, page title, browser language, screen size, its client and session ids). That is normal page analytics, not data from the conversation.
- The widget has no `<form>`, so GA4's automatic form events never fire from it. (The site's own email form in host mode is yours.)

**What a plan link shows:** the link contains game ids, the lesson length (a number, the only part that comes from what the teacher typed) and the language, nothing else typed. But it is an address: when the teacher opens it, your site's analytics (GA4, Clarity) can record the full address, including the part after `#`, so the site can see which games were in a plan that was opened. The same ids reach Ladder Lessons in host mode (with the email address the teacher enters in your form), and the teacher's mail app, clipboard or share sheet otherwise.

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
| Download | **277 MB** (289,982,565 bytes), **measured** in the browser cache on the owner's Mac. This one number is `MODEL_BYTES` in `scripts/build.mjs`, written to `catalogue.compact.json` as `model.bytes`; the button, the one-line offer and the progress all show it. The old estimate read from the model host (it showed 270) is gone. Measure again and change `MODEL_BYTES` whenever the model changes; a unit test fails if the button text and the constant differ. |
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
- `tests/questions.json` has 223 fixed questions in English and Chinese, plus 22 English-Chinese pairs that must give the same games in the same order. They cover every failing case from the test round plus every review round's edge cases:
  - kids, adults, IELTS, DSE and Form 4
  - phonics, reading and vocabulary levels
  - lesson lengths, in digits and in words
  - ages without a unit, number-word ranges, university years, F1 racing, "studied English 3 years"
  - request phrasings with an age but no skill
  - business and work English (Ladder Talk expected), self-introduction, group work and 工作紙 for kids, 返工
  - follow-ups in both languages (`after` = the message before; `newOnly` = no game repeated), including "nothing left"
  - "Year 5 口說" / "Year 5 speaking" with three games
  - round 7: 「Form 4 中秋節口說」 and "Form 4 Mid-Autumn speaking" (a pair) with only Festival Speaking Builder as Main; 「中秋節遊戲」 with Ladder Festivals first and Main; "Halloween speaking" and 「8歲 萬聖節 口說」 with Festival Speaking Builder as Main and Ladder Festivals shown; "adult business English, 45 minutes" without Clinic Day; from the review: 「Form 4 中秋節口說同聆聽 20分鐘」 (several skills), "Let's talk about Christmas games…" ("talk" is not a skill named), "adults, first lesson, 45 min" (ask for the skill), 「kids first lesson, grammar」 without Conditional Studio
  - round 6: Halloween (萬聖節, 萬聖, "trick or treat"), "Form 4 口說" and 「中四 speaking」 with Ladder Talk or Quick Fire as Main (`mainAnyOf`, judged on the plan)
  - round 5: ABC and child words, 上班族 開會英文, festivals in Chinese, several skills in one message, "Form 4 student speaking" = 「中四學生 口說」 (`sameAs`), small talk after a question, 「小三 文法」 / "Year 3 grammar" without Grammar Detective
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
- **The real model's replies:** `tests/fixtures/model-replies-2026-10-06.json` holds the 94 replies Qwen2.5-0.5B gave on the owner's Mac. Replaying them through the old code gives exactly the owner's 119/122; through the current code, 122/122. `tests/fixtures/model-replies-2026-10-11.json` holds the 148 replies from the owner's second run (keyed by question id; follow-ups are left out because the report keeps a conversation's last reply only). Replayed through the code the owner ran (e14e9c6), all 148 give the same cards as the owner's report, including its two failures; through the current code, every fixed question passes.
- **Lesson plan:** step order and minutes for 3 games/30 min, 2 games/25 min, 3 games/no length and 1 game; minutes add up to the length for every length from 1 to 180 and every game's parts; 1B joins with no part name dropped; single-game plan for a game with parts, multi-game for one without; kid-themed never Main for "adult business english" or "Form 4 speaking"; summary lines in English and Chinese; the plan built from AI picks.
- **Plan link:** round trip for every fixed question; only ids, length, language and marker; no typed word; unknown ids skipped; the mailto body.
- **Round 6:** the page-load file is under 32 KB gzip and holds none of the finder (no word list, plan or sending code) and names the finder by its content hash; festival games are never a step without a festival in the question (every fixed question); Halloween first in keyword and AI mode whatever the model picks; the two-dot link format round trip.
- **Round 7:** the review's cases (a festival with several skills, "talk" not naming a skill, keyword answers outside the rules as before, a dropped pick not coming back, a head count, Ladder Vocabulary at any level, the lead's kid-themed card kept, children unchanged, "first lesson"); festival and skill named → Festival Speaking Builder is Main in keyword mode and with four scripted models (Ladder Festivals first, Ladder Festivals alone, the owner's real reply, nothing festive); no skill → Ladder Festivals; the rule with a made-up festival writing game added and with Festival Speaking Builder removed; the owner's off-topic picks for "adult business english", 「成人商業英文」 and 「成人初學者 拼讀」 left out, a picked game about the topic kept, and a child's question unchanged.
- **Matching:** the 22 English-Chinese pairs, `sameAs` pairs, every word group giving the same skill in both languages, festival words, several skills, small talk.
- **What the teacher sees:** for every fixed question with `firstNotKid` or `freeFirst`, the checker also judges the lesson plan's order (`tests/check.js`): the first card shown is never kid-themed, and a free game is the warm-up, Main or the first other game.
- **Download size:** the constant is 289,982,565 bytes = 277 MB, and the button text and README match it.
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
15. **This round:**
   - first open: the AI offer is one line at 320, 375 and 1280px, and all three example chips sit above the composer at 375 and 1280px; the button and the line show 277 MB
   - the header lock line fills the width; the close button sits on the title row
   - the lesson plan in the real UI: heading, summary, step labels and minutes, parts with English names in a Chinese plan, other games, follow-ups, `ll_plan_shown`
   - send without a host form: mail-app hand-off (the only "request" is the `mailto:` with the link and steps), copy with "Copied" for 2 seconds, Share on a phone, no address in the page
   - send with a host form: `sendPlan` called once, its form first, "or copy the link" under it, "Sent…" after `done()` or a Promise
   - a plan link (and a hash change) opens the saved plan without the model; unknown ids skipped; none valid gives the empty state
   - the AI note is 16px below the bottom of the card shadow
   - screenshots of plans in English and Chinese, both send panels, the saved plan and the AI note
16. **Fifth review round:**
   - small talk in the real UI: the polite reply is on screen, "Which skill?" is not repeated, its chips stay active (also after a switch to Chinese), and "2" still answers it
   - a plan link on an open conversation is its own group and closes the old question; with the AI ready, the model gets no message for it
   - the real Clarity library with the site's email form inside the widget: no fingerprint or part of the typed email reaches the upload, and the form still sends
   - on a 375px screen the send options (both modes) come into view when the button is clicked
   - the Chinese send-panel wording in both modes, and the Chinese step labels 暖身 / 主要活動 / 總結
   - the host gets exactly `url`, `mount` (empty), `lang` and `done`; the panel is built once per plan; a failing host form falls back to the mail app
   - `http://localhost:8080/` goes to `demo.html?site=1`
   - cancelling a start from the cache keeps 277 MB on the offer
9. **Device and download:**
   - no `navigator.gpu`
   - phone and in-app user agents
   - simulated GPU: size shown, nothing before the click, failed download falls back
   - cancel
   - fake-model AI path, including crash
   - cached second visit

### Before and after (E3)

**Keyword mode:** `npm run compare` runs the old code (commit fb82fd2, kept in `tests/baseline/`) and the new code on the same questions with the same checker. Result: **before 56/222, after 222/222**. Full table: `tests/results/keyword-before-after.md`.

**This round's questions on the previous version (commit 24133d3) and now:** all 13 of the owner's examples failed before and pass now. 5 more failed before and pass now: 「返工 要同老闆同事開會 想練英文」, 「新年 小朋友 活動」, the English multi-skill question, and "No more, thanks" / "Thanks again!", whose expected answer changed from the off-topic reply to small talk. 6 added with them already passed: two more child-word phrasings, 中秋, speaking and listening, and both Grammar Detective questions (they pass once the new `ages.csv` is built). The first 10 English-Chinese pairs: 3 gave the same games before, 10 now. The review then added 25 more fixed questions and 10 more pairs from its findings (ABC as a name, 新年度, "New Year", work words, skills separated by spaces, "let's talk", exam and middle-school questions, small-talk sentences).

**AI mode, owner's run (2026-10-06, Mac, Apple GPU, Chrome 154, 122 questions):** before 34/122, after 119/122, 0 invalid replies or crashes in 94 model calls. The three failures (Number Ninja, Clinic Day, IELTS Speaking Room dropped or demoted by the model) are fixed by keeping the keyword answer's lead; the replay of those same 94 replies now passes 122/122.

**AI mode, owner's second run (2026-10-11, same Mac, 214 questions):** keyword 214/214, AI 212/214, 0 invalid replies or crashes in 181 model calls. The two failures were "adult business english" and 「成人商業英文」 (off-topic picks, no kid-themed note); fixed in round 7. **Round 7 on the version the owner ran (e14e9c6) and now, 222 questions:** keyword 215/222 → 222/222 (the festival-and-skill and "first lesson" questions); AI with the owner's recorded replies 213/222 → 222/222. Over 2,623 generated keyword questions, the only answers that changed are festival + named skill (192) and "first lesson" (78). The 9 questions added in round 7 need the next run of `model-test.html` to have real model replies.

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
| Page-load cost | 2 requests: `ll-assistant.js` 4.6 KB gzip + `ll-assistant.css` 4.9 KB gzip (was 32 KB + 4 KB before the lesson plan, 47 KB + 5 KB in the round-5 build). Layout shift caused by the widget: 0. **Measured** in headless Chromium |
| First open | `ll-assistant-app.js` 48 KB gzip + `catalogue.compact.json` 17 KB gzip, loaded together, once per visit (then from the browser cache) |
| Model download size | **277 MB** (289,982,565 bytes), **measured** in the cache on the owner's Mac. Download time not measured (the model was already cached) |
| Model start from cache | **1,042 ms** (2026-10-11; 985 ms on 2026-10-06), measured, owner's Mac (Apple GPU, Chrome 154) |
| Time to first answer | **850 ms**; median answer **720 ms** over 181 calls (2026-10-11; 641 ms and 495 ms over 94 calls on 2026-10-06). Measured on the owner's Mac, not a mid-range laptop |
| Page memory (JS heap) | **47 MB**, measured, owner's Mac, both runs |
| GPU memory | ~945 MB is **WebLLM's published estimate, not measured** |
| Model speed (tokens/sec) | **Prefill 2,792 tokens/sec, decoding 70 tokens/sec** (average of 313 answers), measured on the owner's Mac, 2026-10-11. The first run showed `NaN`; fixed before this run |

---

## Repo layout

```
catalogue.json               the only source of games (from games/library.html)
ages.csv                     age_min, age_max, levels, kid_theme per game
ll-tokens.css                site tokens copied from library.html
LL_STYLE_GUIDE.md            brand style guide
data/teacher-fields.csv      optional per-game how-to-run lines
src/ll-assistant.js          the button script (page load)
src/ll-assistant-app.js      the finder (loaded on first open)
src/                         also the CSS and the model worker (plain JS + CSS, no framework)
scripts/build.mjs            builds dist/ll-assistant/ and validates the data
scripts/serve.mjs            local static server
dist/ll-assistant/           ← deploy this folder
demo.html                    local test page (demo.html?site=1 has the site's fonts)
index.html                   sends you to demo.html?site=1
tests/                       questions, checker, unit, browser, compare, model-test, baseline (old code)
tests/fixtures/              the real model's recorded replies, replayed by the unit tests
tests/results/               before/after table and screenshots, written by npm test
```

`dist/` is committed so the folder can be copied without running Node. After editing `src/`, `catalogue.json`, `ages.csv` or the CSV, run `npm run build` and commit `dist/` too.
