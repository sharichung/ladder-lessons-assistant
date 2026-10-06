# Ladder Lessons — Living Style Guide v0.1

> Rebrand 提案（ShariEnglish → Ladder Lessons）
> 色系同字體 **唔係新設計**，係從 `01_CORE_LOGIC.md` 承接落嚟——嗰套本身已經係由 54 個現有遊戲檔實際抽高頻值出嚟。所以呢份 guide 套落舊遊戲唔會衝突。
> 建立日：2026-08-01 · 狀態：**待選定方向後升為 SSOT**

---

## 0. 點解叫 Ladder Lessons

| 項目 | 內容 |
|---|---|
| 品牌名 | Ladder Lessons |
| 一句話 | 將 iPad 由打機工具，變成小朋友自己想開嘅英文練習場 |
| 核心承諾 | 唔洗打印、唔洗準備，開個 link 就玩得，玩完真係學到嘢 |
| 名字邏輯 | Ladder = 階梯。10 個 category 就係 10 級。有進度、有次序、有得升 —— 呢個係 ShariEnglish 冇嘅資產：**它把「54 個散遊戲」變成「一條路」** |
| 已有掛鈎 | `phonics/ladder/` LadderPhonics 已經係品牌內唯一有 curriculum 結構嘅資產，改名之後由「一個遊戲」升格做「品牌原型」 |
| 雙客群 | 家長版 HK$68/月 · HK$580/年 ／ 老師版 HK$128/月 · HK$1,080/年 |

**禁止用語**（沿用 SSOT）：革命性、顛覆、保證考 A、AI 智能學習。唔講療效，只講可觀察到嘅行為改變。

---

## 1. 色系（承接 SSOT，零改動）

### 主色

| Token | Hex | 用途 |
|---|---|---|
| `--brand-coral` | `#FF6B6B` | 主 CTA、重點 highlight、logo 主色 |
| `--brand-teal` | `#4ECDC4` | 次 CTA、答啱 feedback、進度條 |
| `--brand-yellow` | `#FFE66D` | 獎勵／星星／成就感元素 |
| `--brand-ink` | `#2C3E50` | 全部正文同標題 |
| `--brand-cream` | `#FFF9F0` | 頁面底色（唔用純白，減 eye strain） |

### 輔助色

| Token | Hex | 用途 |
|---|---|---|
| `--accent-purple-1` | `#667EEA` | Hero 漸變起點 |
| `--accent-purple-2` | `#764BA2` | Hero 漸變終點 |
| `--state-success` | `#22C55E` | 答啱 |
| `--state-warn` | `#F59E0B` | 提示、時間快到 |
| `--state-error` | `#E74C3C` | 答錯（配震動，唔用刺耳聲） |
| `--ui-line` | `#E5E7EB` | 分隔線、card border |
| `--ui-muted` | `#9CA3AF` | 次要文字、footer 細字 |

### 標準漸變

```css
--grad-hero: linear-gradient(135deg, #667EEA 0%, #764BA2 100%);
--grad-cta:  linear-gradient(135deg, #FF6B6B 0%, #FF8E53 100%);
--grad-win:  linear-gradient(135deg, #4ECDC4 0%, #44A08D 100%);
```

### 用色比例（新增規範 — 呢個係現時最亂嘅位）

| 比例 | 角色 |
|---|---|
| 60% | `--brand-cream` 底 |
| 25% | `--brand-ink` 文字同結構 |
| 10% | 一隻主導色（coral **或** teal，唔好兩隻打交） |
| 5% | `--brand-yellow` 淨係用喺獎勵瞬間 |

**硬規則**：yellow 唔可以做大面積底色，唔可以做文字色（對比度不足）。

---

## 2. 字體系統

```html
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
```

```css
--ff-head: 'Fredoka', 'PingFang HK', 'Microsoft JhengHei', sans-serif;
--ff-body: 'Nunito', 'PingFang HK', 'Microsoft JhengHei', sans-serif;
```

| 層級 | 字體 | Size (mobile / desktop) | Weight |
|---|---|---|---|
| H1 遊戲名 | Fredoka | 28 / 42px | 700 |
| H2 關卡標題 | Fredoka | 22 / 30px | 600 |
| 題目文字 | Nunito | 20 / 24px | 700 |
| 正文／指引 | Nunito | 16 / 18px | 400 |
| 按鈕 | Fredoka | 18 / 20px | 600 |
| Footer 細字 | Nunito | 12 / 13px | 400 |

**中文一定要有 fallback**（PingFang HK / Microsoft JhengHei）—— Fredoka 冇中文字符。

### 中文排版（新增）

- 中文標題唔好用 Fredoka fallback 出嚟嘅預設字重，統一指定 `font-weight: 700` + `letter-spacing: 0.02em`
- 中英夾雜行內，英文前後各留一個半形空格
- 廣東話口語（「唔洗鬧都肯練」）只出現喺家長／老師溝通面，**唔入遊戲 UI**

---

## 3. Logo 概念方向

主 mark 建議由「階梯」抽象化：

- **主 logo**：文字 logotype `Ladder Lessons`（Fredoka 700），"L" 嘅直筆同橫筆構成一級梯級
- **簡化版 / favicon**：三格梯級疊成一個方形圖標，coral 框 + teal/yellow 梯級
- **最小尺寸**：簡化版 16px 要仍然睇得出三格；細過 24px 唔可以用文字 logotype
- **禁用**：唔可以拉伸、唔可以加陰影、唔可以放喺 yellow 底上

### 輔助圖形

| 元素 | 定義 |
|---|---|
| Rung（梯級） | 圓角矩形，圓角半徑固定 `12px`，係全品牌最基本嘅形狀單位 |
| Progress bar | 高度 12px，圓角全滿，teal 填充，`--ui-line` 底 |
| Badge | 圓形或圓角方形，白色 3px 外框，用嚟裝 category icon |
| Category icon | 10 個 category 各一個線性圖標，線寬統一 3px，圓角端點 |

---

## 4. 插畫／影像風格

- **只用 flat vector**，唔用 stock photo，唔用 3D render
- 唔畫小朋友面部特寫；要出現小朋友就畫「手 + iPad」，避開年齡／族裔誤導
- 遊戲截圖係最有力嘅素材 —— **screenshot 優先於插畫**（proof beats decoration）
- 截圖一律放喺 iPad 外框入面，外框用 `--brand-ink` 2px 線
- 唔用漸變做插畫上色，漸變只留返俾 hero 同 CTA

---

## 5. Social 版式範本

### Instagram Feed（1080 × 1350，4:5）

```
上 15%   Hook（Fredoka 700，最多 12 字，ink 或 coral）
中 60%   主視覺（遊戲截圖入 iPad 框 / 單一 category icon）
下 25%   一句 sub + CTA chip
```

- CTA 固定格式：留言 **一個英文字** 領取（例：留言 `GAME`）
- 每張圖右下角固定放簡化版 logo，唔佔多過 8% 寬度

### Carousel

- 封面用 Hook 單張，唔放任何解釋
- 第 2–5 張每張只做一件事（一個痛點 / 一個遊戲 / 一個結果）
- 最後一張先出 CTA，前面唔出

### Story（1080 × 1920）

- 上 20% 同下 20% 留空（避開 UI 遮擋）
- 只用一隻主導色 + cream 底

### Threads

- **純文字為主，唔配圖或只配一張截圖**
- 唔落 sales link、唔落 CTA chip，只做信任建立同互動

---

## 6. 六個視覺方向（概念板已生成，見對話）

| # | 方向 | Core idea | 色系傾斜 | 最適合 |
|---|---|---|---|---|
| 01 | **THE LADDER** | 階梯本身就係 logo，10 級梯級 = 10 個 category | ink + coral | Landing page、品牌識別、家長信任 |
| 02 | **RUNG BY RUNG** | 全套視覺由進度條、等級環、XP badge 砌成 | teal + yellow | 遊戲內 UI、留存溝通、續訂 |
| 03 | **THE SCREEN IS THE PROOF** | iPad 外框係唯一框架元素，截圖做主角 | cream + ink（色由截圖出） | IG demo、廣告、轉換率最高 |
| 04 | **STICKER ARCADE** | 54 個遊戲 = 一張貼紙收集表 | 全色系拉滿 | 小朋友端、Reels、MiniAni 交叉推廣 |
| 05 | **THE TEACHER'S NOTEBOOK** | 筆記紙、手寫註解、粉筆草圖 | ink + cream + 單一 coral | **老師版**、AmazingTalker/Preply 社群滲透 |
| 06 | **FIFTEEN MINUTES** | 巨型數字排版，幾乎零插畫 | coral + ink + 大量留白 | 家長痛點廣告、Founding offer、成熟感 |

### 我嘅建議（唔係要你跟，係要你有得反駁）

**主方向揀 01，執行層借 03。**

- 01 幫你解決「54 個散遊戲」呢個結構性問題 —— 佢係唯一一個令個品牌名成立嘅方向
- 03 係轉換率引擎，但佢本身冇品牌記憶點，做主方向會令你永遠靠內容打天下
- 05 唔好當競爭對手，**當佢係老師版嘅獨立子皮膚**（tier-specific skin）—— 老師唔想見到卡通，家長唔想見到粉筆
- 04 同 02 適合做 sub-system，唔適合做主，因為 04 太小朋友向會壓低老師版付費意欲

---

## 7. Rebrand 影響清單（改名之前一定要睇）

| # | 影響位置 | 現況 | 要做 |
|---|---|---|---|
| 1 | `01_CORE_LOGIC.md` Standard Footer | `se-footer__brand` 寫死 `ShariEnglish`，class prefix `se-` | 改文字。**class prefix 建議唔改**（`se-` 改 `ll-` 要 touch 全部 53 個檔，風險唔值） |
| 2 | Footer link | `https://sharienglish.com` + `IG @sharienglish` | 等 domain 同 IG handle 決定咗先改，改一次搞掂 |
| 3 | Footer legal | `© 2026 ShariEnglish` | 同上批次改 |
| 4 | `04_LANDING_PAGE.html` | 全頁品牌名 | 未接 MailerLite/Payhip，**而家改成本最低** |
| 5 | Domain | roadmap 寫「未決定」 | `ladderlessons.com` 可用性未查 —— 呢個係最大風險，名未確定之前唔好改任何檔 |
| 6 | IG handle | roadmap 未見已開 | 同 domain 一齊查同一齊搶 |
| 7 | `phonics/ladder/` | 已存在 | **零衝突，反而變咗品牌資產**，唔洗改 |
| 8 | 檔名規範 | `category_GameName.html` | 唔涉及品牌名，零影響 |
| 9 | `se_muted` localStorage key | 已有用戶（如有） | **唔好改** —— 改咗會 reset 所有人嘅靜音設定 |

### 執行順序（唔好跳步）

1. 查 `ladderlessons.com` + IG `@ladderlessons` 可用性 → 兩樣都得先繼續
2. 兩樣都搶咗
3. 先改 `04_LANDING_PAGE.html`（未上線，零風險）
4. 選定視覺方向 → 出 logo → 更新 footer 模板
5. **最後**先批量套 footer 落 53 個遊戲檔（呢步係 roadmap Week 2 本來就要做，順手一次過做埋 rebrand，慳一輪）

---

## 8. 測試要求

任何改動 landing page、footer link 或 funnel 之後：

- **一定要開無痕模式（Incognito）行一次完整 funnel**：IG click → free game → email 解鎖 → 付款頁
- 唔可以用平時登入咗嘅瀏覽器測，會被 cache 同已登入狀態呃到
- iPad 直向 + iPhone SE 375px 各測一次（SSOT §7 responsive 底線）

---

## 9. 待決定事項

| # | 事項 | 我需要你回覆 |
|---|---|---|
| 1 | 六個方向揀邊個做主？ | 一個編號 |
| 2 | 老師版用唔用獨立 skin（方向 05）？ | 用 / 唔用 |
| 3 | `ladderlessons.com` 查咗未？ | 未查我可以幫你查 |
| 4 | 舊名保留定完全棄用？ | 完全 rebrand / ShariEnglish 做母品牌 |
