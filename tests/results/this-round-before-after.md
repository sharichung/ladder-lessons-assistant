# 今輪配對問題：改之前 vs 改之後

關鍵字模式（同 demo.html?llai=off 一樣嘅程式）。改之前 = commit 24133d3，改之後 = 而家。顯示嘅係排名次序（課堂安排會再分 Warm-up／Main／Wrap-up）。

| 項目 | 問題 | 改之前 | 改之後 |
|---|---|---|---|
| 6 客套說話 | （先問「Age 8 vocab」）No more, thanks | ❌ none | ✅ smalltalk |
| 6 客套說話 | （先問「Age 8 vocab」）Thanks again! | ❌ none | ✅ smalltalk |
| 1 ABC／小朋友 | 6歲小朋友，ABC還沒認得 | ❌ none | ✅ LadderPhonics, SuperheroRescueLetters, SoundCatcher |
| 1 ABC／小朋友 | 細路 唔識ABC | ❌ none | ✅ LadderPhonics, SuperheroRescueLetters, SoundCatcher |
| 1 ABC／小朋友 | 細路仔 唔識字母 | ✅ SuperheroRescueLetters, SoundCatcher, LadderPhonics | ✅ LadderPhonics, SuperheroRescueLetters, SoundCatcher |
| 1 ABC／小朋友 | 小孩 不會認字母 | ✅ SuperheroRescueLetters, SoundCatcher, LadderPhonics | ✅ LadderPhonics, SuperheroRescueLetters, SoundCatcher |
| 2 上班族／開會 | 上班族 開會英文 | ❌ none | ✅ LadderTalk, LadderFrames, LadderFestivals |
| 2 上班族／開會 | 上班族 想練開會英文 | ❌ none | ✅ LadderTalk, LadderFrames, LadderFestivals |
| 2 上班族／開會 | 返工 要同老闆同事開會 想練英文 | ❌ none | ✅ LadderTalk, LadderFrames, LadderFestivals |
| 3 節日 | 聖誕節 活動 | ❌ none | ✅ LadderFestivals, FestivalSentenceBuilder |
| 3 節日 | 萬聖節 小朋友 | ❌ none | ✅ LadderFestivals, FestivalSentenceBuilder |
| 3 節日 | 新年 小朋友 活動 | ❌ none | ✅ LadderFestivals, FestivalSentenceBuilder |
| 3 節日 | 中秋 節日 遊戲 | ✅ LadderFestivals | ✅ LadderFestivals, FestivalSentenceBuilder |
| 4 多技能 | Form 2學生想練tenses、生字跟文章改錯 | ❌ Detective, TenseStudio, SentenceSurgery | ✅ TenseStudio, Ladder_a1, Ladder_a2, Ladder_b1, Ladder_b2, Detective |
| 4 多技能 | Form 2 student, tenses, vocabulary and proofreading | ❌ TenseStudio, Detective, SentenceSurgery | ✅ TenseStudio, Ladder_a1, Ladder_a2, Ladder_b1, Ladder_b2, Detective |
| 4 多技能 | Age 9, speaking and listening | ✅ QuickFireFlashcards, FestivalSentenceBuilder, AnnouncementStation | ✅ QuickFireFlashcards, AnnouncementStation, FullSentences |
| 5 中英一致 | 中四學生 口說 | ❌ QuickFireFlashcards, LadderTalk, HookLab | ✅ QuickFireFlashcards, FestivalSentenceBuilder, LadderTalk |
| 5 中英一致 | Form 4 student speaking | ❌ QuickFireFlashcards, FestivalSentenceBuilder, LadderTalk | ✅ QuickFireFlashcards, FestivalSentenceBuilder, LadderTalk |
| 6 客套說話 | （先問「Age 8」）thanks | ❌ none | ✅ smalltalk |
| 6 客套說話 | （先問「Age 8」）ok | ❌ none | ✅ smalltalk |
| 6 客套說話 | （先問「8歲」）多謝 | ❌ none | ✅ smalltalk |
| 6 客套說話 | （先問「8歲」）唔該 | ❌ none | ✅ smalltalk |
| 9 Grammar Detective | 小三 文法 | ✅ TenseStudio, QuestionMaster, ComparativesSuperlatives | ✅ TenseStudio, QuestionMaster, ComparativesSuperlatives |
| 9 Grammar Detective | Year 3 grammar | ✅ DeterminerStudio, BecauseOrBut, TenseStudio | ✅ TenseStudio, QuestionMaster, ComparativesSuperlatives |

## 中英對照（頭 10 對，要同一批遊戲、同一個次序）

| English | 中文 | 改之前 | 改之後 |
|---|---|---|---|
| Form 4 student speaking | 中四學生 口說 | ❌ EN: QuickFireFlashcards, FestivalSentenceBuilder, LadderTalk ／ 中: QuickFireFlashcards, LadderTalk, HookLab | ✅ QuickFireFlashcards, FestivalSentenceBuilder, LadderTalk |
| Age 6 phonics | 6歲 拼讀 | ❌ EN: LadderPhonics, SoundCatcher, WordSmash ／ 中: LadderPhonics, WordSmash, SoundCatcher | ✅ LadderPhonics, WordSmash, SoundCatcher |
| adult business English | 成人 商務英文 | ✅ 一樣 | ✅ LadderTalk, MiniBusinessTycoonSuper, YoungEntrepreneur |
| 8 year old vocabulary 30 minutes | 8歲 生字 30分鐘 | ❌ EN: Ladder_a1, Ladder_a2, FruitAtoZ, HealthyPlate ／ 中: Ladder_a1, Ladder_a2, FruitAtoZ, MatchingGame | ✅ Ladder_a1, Ladder_a2, FruitAtoZ, MatchingGame |
| P3 listening | 小三 聽力 | ✅ 一樣 | ✅ AnnouncementStation, NumberNinja |
| Form 2 tenses | 中二 時態 | ❌ EN: TenseStudio, SentenceSurgery, Detective ／ 中: TenseStudio, Detective, QuestionMaster | ✅ TenseStudio, Detective, QuestionMaster |
| 10 year old writing | 10歲 寫作 | ❌ EN: RolePlayWriting, TowerOfSentences, ChainStory ／ 中: TowerOfSentences, ChainStory, DetectivesNotebook | ✅ RolePlayWriting, TowerOfSentences, ChainStory |
| Christmas activity for kids | 聖誕節 小朋友 活動 | ❌ EN: LadderFestivals ／ 中: none | ✅ LadderFestivals, FestivalSentenceBuilder |
| IELTS speaking | 雅思 口試 | ✅ 一樣 | ✅ IeltsSpeakingRoom, LadderTalk, HookLab |
| office workers, English for meetings | 上班族 開會英文 | ❌ EN: LadderTalk, QuickFireFlashcards, IeltsSpeakingRoom ／ 中: none | ✅ LadderTalk, LadderFrames, LadderFestivals |
