# 架構與機制

每一節講一個機制**現在怎麼運作、為什麼這樣做**。改哪一塊之前先讀對應那一節。


## 一題問答是怎麼跑的(關掉分頁也不會不見)

claude 跑一題動輒幾分鐘、跨模組的問題十幾分鐘,所以使用者一定會在中間關掉分頁、
重新整理、或走到另一台電腦。**回答因此不是掛在 HTTP 連線上跑的**:

1. `POST /api/ask` 一進來就先寫一筆 `status="running"` 的 `QARecord`,對話清單、
   歷史、網址從第一秒就成立
2. claude 交給一個背景 asyncio task 跑(`runs.py` 的 `Run`),事件(delta / source /
   queued / notice)累積在記憶體裡
3. HTTP 回應只是「觀看」那個事件流 —— 斷線不影響 run,它照樣跑到完、照樣寫回資料庫
4. 前端一載入就打 `GET /api/ask/runs` 問「有哪些還在跑」,再用
   `GET /api/ask/runs/{id}/stream` 接回去。這條串流**會從第一個事件重播**,
   所以連中間讀過哪些檔案都補得回來
5. 停止是 `POST /api/ask/runs/{id}/stop`,不是關掉瀏覽器這端的連線 ——
   關連線它會照跑完、照計費。停止時已經寫出來的內容會保留下來存進資料庫

> ⚠️ 取消一個 async generator 時,如果它當下停在 `await` 而不是 `yield`,進到
> `stream_agent` 的是 **CancelledError 而不是 GeneratorExit**。只接 GeneratorExit 的話
> 那條路會直接穿過去,claude 子行程就沒人砍,會一直空跑到逾時。

事件只在記憶體裡,所以服務重啟時進行中的那幾題會斷掉 —— `main.py` 啟動時會呼叫
`close_orphan_runs()` 把殘留的 `running` 紀錄收尾成失敗,不然畫面上會永遠停在
「回答中」等一個不會來的答案。

同仁的問答全站同時只跑 `MAX_CONCURRENT_ASKS` 題(預設 10),每人最多
`MAX_CONCURRENT_ASKS_PER_USER` 題(預設 3),排隊期間會持續送 `queued` 事件,
前端顯示「排隊中,前面還有 N 題」。這同時也當心跳用:排隊那段時間如果連線完全沒有
流量,中間的 SSH 通道/反向代理很容易把它當成死連線切掉。

## 資料庫:表與欄位

表由 `create_all()` 在服務啟動時建(`main.py` 的 `init_database()`),不需要手動 migrate。

> ⚠️ **`create_all()` 只建缺少的表、不動已存在的表。** 所以往一張**已經存在**的表加欄位,
> 既有的資料庫不會自己長出那一欄,症狀是寫入時 `table xxx has no column named yyy`。
> 改了 models 的欄位,已經在跑的資料庫要自己 `ALTER TABLE`(開發時也可以直接刪掉
> `backend/data/app.db` 讓它重建)。加一張新表則不用做任何事。

- **`users.role`** —— 畫面上的職稱(@ 選單名字底下那行副標)。nullable,
  沒設過的在讀的那側退回 `users.DEFAULT_ROLE`("Consultant")。

  ⚠️ **職稱就是權限**:`role` 是唯一來源,`tools` 由 `users.role_grants_full()`
  推導、只是給 `agent.py` 讀的快取欄位。**不要從別的地方寫 `tools`** ——
  兩個地方都能寫就一定會不一致,而不一致的那一面是「畫面顯示 Consultant、
  實際上有 Bash」。管理員另外看 `ADMIN_USERNAME`(他不在 users 表裡)。
  回歸測試在 `backend/tests/test_users_role.py`。

## 怎麼確定回答真的根據程式碼

這套系統最容易出錯又最難察覺的一件事:claude 沒去翻程式碼、憑既有印象回答,而答案
讀起來一樣有條理。所以有兩層機制。

**第一層,明確告訴它去哪裡讀。** 專案在 `knowledge_bases.json` 裡帶著
`code_roots` / `knowledge_dirs`,這兩組路徑會被寫進每一次的提示(見 `agent.py` 的
`build_context_note`)。之所以要明講,是因為工作目錄底下常有 symlink、`CLAUDE.md`
也可能寫著別的路徑寫法,光看目錄結構會挑錯樹 —— 挑錯了答案表面完全看不出來。

**第二層,把它讀過什麼攤開來。** `agent.py` 會收集串流裡的 `tool_use` 事件,記錄這一題
實際 Read/Grep/Glob 過哪些路徑,存進 `qa_records.sources`,聊天頁會顯示
「參考了 N 個來源」。路徑會保留最後一段目錄名(`src/orders/checkout.py`、
`docs/modules/orders.md`),所以一眼就能分辨來源是原始碼還是文件。

> 答案下面寫「這則回答沒有讀取任何檔案」,就代表它沒查程式碼。這是刻意顯示的,
> 不是缺陷 —— 打招呼之類的問題本來就不需要查。

## 問題怎麼被回答的(路由設計)

前端只有一個問題輸入框,**不會**讓使用者選模組或選 agent 類型。使用者的原始問題會
原封不動丟給主機上的 `claude`,要用哪個 skill、查哪個模組完全由 workdir 的
`CLAUDE.md`/skills 自己判斷(見 `backend/app/agent.py` 的 `build_prompt`)。

> 所以 skill 要能「看問題內容自動觸發」。如果你的 skill 都要靠手動打 `/某個-skill`
> 才會觸發,要在 workdir 的 `CLAUDE.md` 補一層路由判斷。

## 每一步花了多少:`qa_steps` 跟 `sources` 是兩份故意不一樣的資料

上一節那份 `sources` 是**給使用者看的**,所以它去重(見 `agent.py` 的 `seen_sources`)——
同一個檔讀三次,聊天頁只會顯示一次。

查成本要的正好相反:想知道錢花在哪,**「同一個檔被讀了六次」就是最重要的那個訊號**,
而它剛好是去重會吃掉的東西。所以流水帳另外存一張表 `qa_steps`(`models.QAStep`),
**照發生順序,一列都不去重**。兩份資料的用途相反:一個要乾淨,一個要完整,不要為了省一份把它們合併。

### token 記在「輪」上,不是記在「工具」上

一次模型呼叫(一輪)可能同時發出六個工具呼叫,而帳是**整輪一起算**的 ——
沒有辦法誠實地拆給個別工具。

真正能歸給工具的是**下一輪的 `input_tokens`**:那一輪的輸入裡沒有命中快取的部分,
幾乎就是上一輪那些工具的結果被讀進來的量。所以要看「這個工具貴不貴」,
看的是它**下面那一列**的輸入,不是它自己那一列。

> ⚠️ **不記每一步的美金。** CLI 只在最後的 `result` 給一題的 `total_cost_usd`,
> 要拆到每一輪就得在後端維護一張各模型的價目表 —— 那張表一定會過期,而過期的數字
> 看起來很合理但其實是錯的。token 是事實,錢留在題的層級(`qa_records.cost_usd`)。

子代理(`Task`)裡面的模型呼叫標成 `subturn`:它一樣要花錢(所以 token 照算),
但不是主線的一輪 —— 混進去算的話,「這一題跑了幾輪」會被灌水。

### 「第幾秒發生」跟「花了多久」是兩個量

`at_ms` 是**距離開題第幾毫秒**,`duration_ms` 才是**這一步花了多久**,
而且**後者算不出來、只能量**:

`content_block_stop` 代表「模型把這通工具呼叫**寫完**了」,而工具是在整則
assistant 訊息結束**之後**才執行的 —— 所以拿相鄰兩個 tool_use 的 `at_ms` 相減,
量到的是模型吐字的速度,不是工具的耗時。真正的耗時要等對應的 `tool_result`
回來,用 `tool_use_id` 配對(`agent.py` 的 `step_duration` 事件,晚到,
由 `ask.py` 回頭補進那一列)。

沒等到 result 的(被停止、逾時)`duration_ms` 留 `NULL`,畫面上留白 ——
**不要補 0**,0 會被讀成「這一步是瞬間完成的」,而事實是我們不知道。
畫面上那個偏移量前面刻意加 `+`,免得一排時間戳被讀成一排耗時。

### 「這一題算誰問的」只有一條規則

`stats.py` 的 `_asker()`:`coalesce(asked_by, owner)`,**排行榜跟明細頁共用**。

用的是**送出的人**不是 owner —— 共用對話裡別人續問的那幾題,owner 掛的是原作者
(見 `ask.py` 的 `record_owner`),用 owner 算會把題目記到沒問過它的人頭上。
兩處用不同規則的話,點進去看到的題數會跟排行上那個數字對不起來,而畫面上看不出是哪邊算錯。
守門的測試是 `test_qa_steps.py::test_ranking_and_detail_use_the_same_asker_rule`。

### 流水帳只收不 emit

`agent.py` 多吐一種 `step` 事件,但 `ask.py` 收下來之後**不會 `run.emit()`**:
一題幾百步,送進 `events` 的話每個重新接上的訂閱者都要重播一遍,而畫面上根本不用它
(畫面用的是去重過的那份)。

`usage` **只有 `assistant` 訊息拿得到** —— `stream_event` 的 `message_start` 只有半套
(輸出還沒發生),最後的 `result` 只有一題總額,拆不出每一輪。認不得的欄位一律留 `NULL`,
**不要填 0**:事後看到一輪 input 是 0 會以為快取全中。

### 兩種空:沒查任何檔 vs 沒有明細

「這題沒查任何檔」跟「這題沒有留下每步明細」(早於這張表、或明細已過保留期)在畫面上都是
一片空白,意思卻完全相反 —— 所以 API 每一筆都帶 `has_steps`,前端照它明講「這一題沒有每步明細」,
不要顯示成 0。

### 保留期

`QA_STEPS_RETENTION_DAYS` 預設 **90 天**,開機時清一次(`database.purge_expired_steps`),
0 = 永遠不刪。

一定要有這個上限:流水帳是問答本身的十幾倍到上百倍,而且不去重。不設上限的話幾個月後
統計頁會開始慢。查成本問題看的一定是最近的資料,長期趨勢看題層級的 `cost_usd`(永久保留)。
清的時候比對的是**問答的 `created_at`**,不是流水帳自己的時間:一題的明細要嘛整題都在、
要嘛整題都不在,半題的時間軸看了只會誤導。

### 刪對話是軟刪除:帳留下來,內容真的清掉

管理員的用量統計是從 `qa_records` 算的。刪對話如果整列刪掉,成本、token、誰問的會一起消失,
統計數字整段對不上而且沒有任何線索。所以 `delete_conversation` 做兩件事,**少了任何一半都不對**:

| 動作 | 為什麼 |
|---|---|
| 標記 `deleted_at` | 這一列要留著,統計才算得到成本與 token |
| 清空 `question` / `answer` / `sources` / 附件欄位 | 使用者按刪除,要的是那些字消失 |
| 清空流水帳的 `target` / `target_full` / `detail` | 同上,而且**這一個最容易漏** ↓ |

留下來的只有數字與身分:誰、什麼時候、跑了幾輪、花了多少。

⚠️ **流水帳(`qa_steps`)那一列很容易漏掉。** 軟刪除之後那些列還在,而管理員的題目明細頁
照樣送得出去 —— 裡面是**檔案路徑、搜尋字串、完整的 Bash 指令**,對一筆標著「已刪除」的
紀錄來說,那比問題原文還敏感。原則是:**留數字,清標的**。

讀取端的規矩:**每一條給使用者看的路徑都要濾掉它**,唯一的出入口是
`conversations.visible_to`。除了它,還有兩個地方必須各自濾一次 ——
`shares.owner_of` 與 `ask.py` 裡那個「舊 session」的回退。漏掉的話,拿舊網址對一組
已刪的對話續問會被判定成「你就是原作者」,claude 那側會 `--resume` 回原本的 session,
**把使用者以為刪掉的內容整段讀回模型的上下文裡**,而且完全看不出來。
`tests/test_soft_delete.py` 守著這幾條。

> ⚠️ `qa_steps` 的 FK 要帶 `ON DELETE CASCADE`。刪對話不刪 `qa_records`,
> 但**帳號刪除等其他路徑會走真的 delete**,而那些路徑不經過 ORM,
> ORM 層的 cascade 設定在上面不會生效。

### 畫面在哪

`/stats`(總覽:幾題、誰問得多)點任一個帳號 → `/stats/questions`(明細),已經幫你篩好那個人。
兩頁回答的問題不一樣:總覽回答「多不多」,明細回答「為什麼這麼貴」。

- **`/stats` 的篩選只有起訖一格,預設「今天」。** 昨天以前的題目不在畫面上、排行榜也只算
  今天問過的人 —— 有人回報「某人的問題不見了」時,先看起訖選到哪裡。網址帶 `range=all`
  就是全部期間。
- **篩選條件都住在網址上**(`/stats` 的 `start` / `end` / `range`,明細頁的 `user` / `start` / `end` /
  `q` / `order` / `page`):重新整理留得住,從總覽跳過來時條件也不會被丟掉。
- `/stats` 最上面有一塊**「正在執行」**:此刻正在跑的題目,每 5 秒自動更新,不受起訖影響,
  沒人在跑時整區不出現。它走 `/api/stats/running`(管理員專用,全站一覽)——
  **不是** `/api/ask/runs`,那一支刻意只回「自己的 + 分享給自己的」,管理員也不例外
  (它的用途是把自己問到一半的對話接回來,不是監看)。資料只在記憶體裡,服務一重啟就全空。
- 明細頁每題顯示**問題全文,不截斷** —— 這一頁存在的理由就是「他到底問了什麼」。
  點「看每一步」展開時間軸:預設只看動作,切到「含用量」才照輪分組(工具收在發動它的那一輪底下)
  並列出 token;最上面先列**重複碰到的標的**。

## prompt cache:不能讓快取前綴每題都變

prompt cache 是**前綴比對**:前綴裡任何一個位元變了,後面全部失效。CLI 的預設系統提示裡
放著 `cwd`、`env info`、`memory paths`、`git status` 這些每題都可能不一樣的區段 ——
前綴一變,後面的 `CLAUDE.md`、規則檔以及**整段對話歷史**,每一題都要用 1.25 倍的寫入價
重買一次,而它們本來該用 0.1 倍的讀取價命中。失效的指紋是:每題第一輪的 `cache_read_tokens`
停在一個不動的小常數,`cache_creation_tokens` 卻等於那組對話當下的全長。

### 三個旗標(`config.py` 的 `CLAUDE_*`,都可由 `.env` 調)

| 設定 | 旗標 | 預設 | 影響答案內容嗎 |
|---|---|---|---|
| `CLAUDE_STATIC_SYSTEM_PROMPT` | `--exclude-dynamic-system-prompt-sections` | **開** | 否。那幾段照樣送,只是搬到第一則使用者訊息 |
| `CLAUDE_STRICT_MCP` | `--strict-mcp-config`(不給 `--mcp-config`) | **開** | 否。拿掉的是主機上其他 MCP server 那種**兩組白名單都沒有**、永遠呼叫不到的工具定義 |
| `CLAUDE_MAX_BUDGET_USD` | `--max-budget-usd` | 關(留空) | **會**。撞上限會截斷答案,所以預設不開 |

⚠️ 前兩個**預設是開的** —— 部署上去、`.env` 一個字都不改,行為就會變(變的是成本
不是答案)。這跟這個專案「新行為預設關」的慣例不同,理由是它們對答案內容零影響。

⚠️ `--exclude-dynamic-system-prompt-sections` **只在預設系統提示下生效**,一旦
`agent.py` 加上 `--system-prompt`,CLI 會**靜默**忽略它,而症狀是成本悄悄漲回去。

⚠️ 刻意**沒有** `CLAUDE_AUTOCOMPACT`。`--autocompact` 是**有損**的(壓縮會把舊的
工具結果摘要化),而這裡的答案品質標準正好是 `檔案:行號`,失真了從答案表面看不出來。
加之前先看 `config.py` 裡那段說明。

### `--add-dir` 的清單在同一組對話裡不能變

`--add-dir` 的清單也是快取前綴的一部分:`--resume` 時換掉其中一個目錄,整段歷史就要重買。
所以每題不同的 `uploads/{session_id}`、`outputs/{session_id}` **不掛進 `--add-dir`**,
改由 `--allowedTools` 的絕對路徑規則放行讀與寫。`--allowedTools` 裡的 session 路徑規則可以留:
allow 規則不改變模型看到的工具定義,不進前綴。

⚠️ **唯讀帳號讀得到什麼由 `--allowedTools` 決定,不是「什麼都讀得到」。**
「Read 本來就不受 `--add-dir` 限制」只對 full 帳號成立;唯讀那組的 `Read`/`Grep`/`Glob`
是 `Read(//路徑/**)` 這種路徑限定寫法,**可讀目錄漏掉一個,那類檔案就從此讀不到**,
而畫面上只會看到模型說找不到檔案。清單怎麼算的寫在 `agent.scope_readonly_tools`。
唯讀那組名單裡如果有人加了 `Bash(...)`,路徑限定會整個失效,服務 log 會叫一行警告。

### 驗收方式

改完不要假設它生效了 —— 在同一組對話裡連問兩題(5 分鐘內),去 `qa_steps` 看
**第二題第一輪**的 `cache_read_tokens` 有沒有讀到前一題的內容(幾萬起跳)。
停在一個每題都一樣的小常數 = 只有最前面那段固定的系統提示進得了快取;0 = 完全沒命中。
沒生效時先查是 `--resume`、`--add-dir` 還是 `--allowedTools` 在同一組對話裡變了
(最常見的是每題不同的目錄被掛進 `--add-dir`)。

## Bash 與讀檔紀律

`Read` / `Grep` / `Glob` 碰得到的範圍是「工作目錄底下」加上「`--add-dir` 掛進來的那幾條」
(唯讀帳號再加上路徑限定)。**`Bash` 不吃 `--add-dir`** —— `config.py` 把這件事當成**安全**
風險寫下來了:給了 Bash 就等於給了那個帳號「以服務身分讀寫主機上任何東西」。
所以 Bash 只在 `ALLOWED_TOOLS_FULL`(職稱 Software engineer 與管理員)裡,
也不要用 `Bash(find:*)` 這種寫法「只開一點點」(`find -exec` 照樣能跑任何指令)。

就算有 Bash,讀檔也要走 `Read` / `Grep`。這條寫在規則層(`RULES-web-context.md` 的
「用 Read / Grep / Glob 讀檔,不要用 Bash」),理由以**成本**為主、隔離為輔:`cat` 沒有
`offset`/`limit`,一支大檔整支灌進上下文,而那段內容會在這一題剩下的每一輪、以及這組對話
後面的每一題被重送。讀檔紀律(Grep 定位 → Read 帶 `offset`/`limit`)也在同一份規則檔裡。

> ⚠️ 要從 `qa_steps` 追查 Bash 指令碰了哪些路徑,用 `target_full`(2,000 字上限,見 `agent.py`
> 的 `_MAX_TARGET_FULL_CHARS`),而且判斷式要雙向
> (`p.startswith(root) or root.startswith(p)`)—— 兩個欄位都會截斷。

## 用量上限:答完那句「本次耗用 … 剩餘 … 後重置」

上一節講的是**錢**(每一題的 token 與美金成本)。這一節講的是**額度** —— Claude 訂閱那個
5 小時滾動視窗的百分比。額度**不在這個專案裡**:唯一知道它的是 claude CLI 自己,答案放在
`/usage` 這個 slash 指令裡。

所以做法是用 `-p` 跑一次 `/usage`,把它印出來的那段字剖成數字
(`backend/app/usage_limit.py`,端點 `GET /api/usage-limit`)。前端在**每一題答完**打一次,
小夥伴接著把它唸出來。

### 剖不出來就少講一句,絕不猜一個數字

那段輸出的格式是 CLI 給的、升版就可能變。整支的原則是「剖不出來就回 None」,
而端點**讀不到就回 `{"available": false}`,不回 500**:

- 那句話是要唸給人聽的。講一個看起來很正常、其實是瞎編的百分比,比不講糟得多。
- 回 500 的話,前端每答完一題都會在主控台留一條紅字 —— 而這只是一句附加的話沒講成,
  答案本身完全正常。前端拿到 `available: false` 就只顯示「回答完成」。

剖析本身抽成 `parse_usage()` 這種模組層純函式,是為了**測得到**:格式一變,要對
的就是那一支,不必真的去起一個子行程。

> ⚠️ 「這一行是不是在講額度」是一道**安全**條件,不只是剖析的講究。萬一某個 CLI
> 版本把 `/usage` 當成一般提示丟給模型,回來的會是一段模型的回答 ——「我 100%
> 確定幫不上忙」裡的那個 100% 不能被當成額度唸出來。所以要求同一行出現
> `_USAGE_LINE_KEYWORDS` 裡的字眼。

### 快取:60 秒,而且「讀不到」也要記得

這支會被「每一題答完」觸發,而主機同時可以跑 `MAX_CONCURRENT_ASKS` 題 ——
沒有快取的話尖峰時會有一串 claude 行程只為了問額度。所以用一份模組層快取
(`CACHE_TTL_SEC = 60`)加一把鎖:TTL 內共用同一份答案,同時進來的人共用同一次執行。

答完那一次走 `?fresh=1` 不吃快取 —— 不然一題在 60 秒內答完,差值永遠是 0。
送出那一次不帶,吃快取就好。

> ⚠️ **「問過了沒」看時間戳,不看快取內容是不是 None。** 讀不到也是一個結果,
> 而且更要記得:CLI 壞掉的那段期間,每一題答完都再起一次子行程、各等滿
> `TIMEOUT_SEC`,等於把故障放大成每題 30 秒的延遲。

## 一個專案一條路:工作目錄跟著專案走

| | 決定什麼 | 靠什麼 |
|---|---|---|
| 「**看得到什麼**」 | 讀得到哪幾棵程式碼樹與文件 | `code_roots` / `knowledge_dirs` → `--add-dir` |
| 「**我是誰**」 | 載入誰的 `CLAUDE.md`、自己那份 `.claude/skills/`、session 存在哪 | `workdir` → 子行程的 `cwd` |
| 「**共用什麼**」 | 幾個專案共用的那組 skill | `skill_dir` → `--add-dir`,它的 `.claude/skills/` 一樣會載入 |

`skill_dir` 是選填,填一個「裡面有 `.claude/skills/` 的目錄」(目錄自己建,skill 自己搬進去)。
⚠️ 它會被掛成唯讀可讀,所以裡面只放 skill。不需要共用 skill 的專案就留空,
不相容的兩組 skill 不要混在同一個目錄。填的路徑不存在就當沒填,只留一行 warning。

每個專案在 `knowledge_bases.json` 有自己的 `workdir`。填的目錄**必須存在**;
不存在會退回 `.env` 的 `CLAUDE_WORKDIR`,服務照跑、答案照出,但那個專案的隔離
不會生效 —— 而畫面上完全看不出來,所以降級時會在服務 log 留一行 warning,
**啟動後要去服務 log 掃一次有沒有那行**(Docker 版:`docker compose logs askme | grep "workdir 不存在"`)。

### 續問一定要回到當初那個目錄

claude 的 session 檔存在 `~/.claude/projects/<工作目錄代號>/` 底下,所以 `--resume`
換了 `cwd` 就是「查無此 session」。因此 `ConversationMeta` 除了 `claude_session_id`
還存 `workdir`,兩個是一組的、一起寫也一起覆蓋:

- **新 session** → 用這個專案自己的 `workdir`,隔離就在這一步成立。
- **續問** → 用 `meta.workdir`,**不是**現在設定的那個。
- `meta.workdir` 是 `NULL` → 這組對話建立時沒有記 workdir,照 `CLAUDE_WORKDIR` 走。

### `agent-knowledge/` 刻意不跟著專案走

上傳與產生的檔案全部放在 `AGENT_KNOWLEDGE_DIR`(本機預設 `backend/data/agent-knowledge`)。
理由:存檔與取檔都只靠 `session_id` 定位,沒有專案這個維度 —— 附件跟問題一起由
`POST /api/ask` 的 multipart 送進來,存到 `uploads/{session_id}/`;下載端點
(`GET /api/files/...`、`GET /api/uploads/...`,`/api/uploads` 只有 GET)與檔案區也只拿
`session_id` 找檔案。依專案分家的話,取檔的每一支都要先反查「這個 session 當初是哪個專案」。

> ⚠️ **它也不能落在任何一個專案的 `workdir` 底下。** `cwd` 底下的東西不需要
> `--add-dir` 就讀得到,所以落在某個專案裡,那個專案就翻得到**所有人**的上傳與產出。
> `config.py` 有一段開機檢查,落在專案 workdir 底下會在 log 叫出來。搬家只要
> `mv` 目錄 + 改 `.env` —— 資料庫只存 `session_id` 與檔名,路徑是算出來的。

這個目錄**不在版控裡**:後端第一次寫檔時自己建(`uploads.py`),Docker 版由 `entrypoint.py`
在 volume 裡建好 `uploads/` 與 `outputs/`。兩個資料夾會隨問答累積,清舊 session 沒有排程,
手動清即可 —— 檔案刪掉後,檔案區對那些紀錄顯示「No longer on the server」,不會壞。

代價是那個目錄落在所有專案的 `cwd` 之外,所以:

- 提示裡的上傳檔路徑一律是**絕對路徑**。
- 這一題自己的 `uploads/{session_id}` 與 `outputs/{session_id}` **不掛進 `--add-dir`**
  (理由見「prompt cache」那節);讀與寫都靠 `--allowedTools` 的路徑規則放行,
  **續問還要把同一組對話前幾題的 `session_id` 一起放行**,不然「剛剛那份 PDF」會讀不到。
  ⚠️ **絕對不要改成掛 `agent-knowledge` 整層** —— 那等於任何人都能叫它去翻別人上傳的檔案
  (下載端點擋得住外人,但擋不住「模型自己被指使去讀別人的目錄」)。
- 寫檔權限規則同時保留相對與絕對兩種寫法(見「寫檔權限」那節)。

## 檔案上傳

- 使用者在聊天頁可以附加檔案,存到 `agent-knowledge/uploads/{session_id}/{原檔名}`,
  claude 讀取這個路徑作為問題參考。
- **圖片會在瀏覽器端先縮到長邊 1568px 再上傳**(`frontend/src/lib/image.ts`)。
  一張全螢幕截圖原檔好幾 MB、4K 截圖 20 MB 以上,這些位元組要穿過網路與反向代理送到主機,
  傳到一半斷線整題就失敗。縮小沒有代價:模型讀圖本來就會把長邊縮到 1568px。
- **單檔上限 50 MB**(`MAX_UPLOAD_MB`)。0 等於任何登入者都能把硬碟塞滿,
  而上傳目錄通常跟資料庫、原始碼樹在同一顆碟上。設 0 才是不限制,但別這樣做。
  配套的請求大小與硬碟餘量限制見「站在路由前面的兩道閘」。
- **上傳失敗一定要講出來**:檔名不合法、或超過上限時,前端會在送出前就擋下並說明原因,
  後端另外會送一個 `notice` 事件顯示在該則回答上方。靜靜略過的話,使用者會以為 AI 看過
  那張截圖,拿到答非所問的回覆還不知道為什麼。
- **Office 檔在上傳當下就抽成純文字**(`extract.py`),claude 讀的是抽出來的 `.txt`,
  不必自己解壓縮。⚠️ 這一層最貴的錯是**抽不到不會報錯**:抽少了,claude 只會看到
  比較少的東西,然後照樣給一個很肯定的答案。三個一定要自己走一遍的地方:
  Word 的**表格**(`doc.paragraphs` 不含表格,而規格類文件的內容幾乎全在表格裡)、
  PowerPoint 的**表格與備忘稿**(表格圖形沒有 `text_frame`)、群組圖形。
- **舊格式(`.doc`/`.xls`/`.ppt`)**:`.xls` 用 xlrd 讀得出來;另外兩個讀不了,
  這時**明講**「請另存成新格式再上傳」並要 claude 不要猜 —— 不講的話它會去讀原始檔,
  拿到亂碼再掰一個答案。判斷依據是 OLE2 檔頭,所以「副檔名叫 `.xls`、其實是系統匯出的
  tab 分隔文字」那種還是照樣讓 claude 直接讀(那才是對的)。

## 產生檔案:沒有 Bash 也要給得出 Excel / Word / PDF / 簡報 / 壓縮檔

- 如果 claude 判斷需要產生檔案給使用者,會被引導寫到
  `agent-knowledge/outputs/{session_id}/`,前端問答結果下方會顯示下載連結。
- **那個資料夾一定要由後端先建好**(`agent.py` 啟動子行程前 `mkdir`)。沒建的話
  claude 得自己 `mkdir`,而唯讀帳號沒有 Bash —— 它會卡住,然後開始跟使用者解釋
  「請去 `/permissions` 開權限」,而使用者照做也沒用(CLI 旗標給的 allowedTools
  跟 settings 裡的規則不是同一套)。提示裡給的是**絕對路徑**,並明講「資料夾已經建好,
  不要用 mkdir/cp/mv」。跑完沒產生任何檔案的話,那個空資料夾會被收掉
  (見 `routers/ask.py` 的 `_finalize`)。
- **權限設計**:唯讀帳號的 `--allowedTools` 完全唯讀,只有 `outputs/{session_id}/` 這
  一個資料夾在**當次呼叫**額外開放寫入(`agent.py` 的 `scoped_write_rules` ——
  `Write`/`Edit` × 相對/絕對路徑共四條),原始碼樹跟其他路徑仍然唯讀。

### 二進位格式一律由後端產,claude 只寫純文字

`.xlsx`/`.docx`/`.pptx`/`.zip` 是一包 zip、`.pdf` 有自己的結構,Write 工具寫出來的一定是壞檔,
而唯讀帳號沒有 Bash 跑不了轉檔程式。**提示裡一定要講這件事** —— 不講的話模型不知道有
後端這一層,會回一句「我沒辦法產生 Excel 檔」就結束,而它其實寫得出 `.csv`。

| 使用者要的 | claude 寫什麼 | 後端 | 產出 |
|---|---|---|---|
| Excel | `.csv`(**不用 manifest**,掃到就轉) | `sheetgen.py` + openpyxl | 同名 `.xlsx`(csv 也留著) |
| Word | `.md` + `__docx__.txt` 點名 | `docgen.py` + python-docx | 同名 `.docx` |
| PDF | `.md` + `__pdf__.txt` 點名 | `pdfgen.py` + reportlab | 同名 `.pdf` |
| 簡報 | `__slides__.json` | `slidegen.py` + python-pptx | `.pptx` |
| 多檔打包 | `__zip__.txt`(第一行是檔名) | `zipgen.py` + 標準庫 | `.zip` |

邊角(清單怎麼讀、檔名怎麼清、撞名怎麼辦、函式庫沒裝說什麼)在
`backend/app/outputs_common.py`,五支共用。同一份 `.md` 可以同時列在 `__docx__.txt` 與 `__pdf__.txt`。

五條共同的規矩,加新格式時照抄:

1. **一定要排在 `list_output_files` 前面。** 不然產出來的檔案不會進下載清單 ——
   而畫面上不會有任何錯誤,答案裡卻說「已經產生」。
2. **失敗只回訊息、不丟例外。** 收尾階段答案已經算完、錢也花了。
   ⚠️ 連刪 manifest 都算:`unlink` 自己會丟 `OSError`,寫在 `finally` 裡會逃出去。
3. **manifest 用完就刪**,它是給後端看的中間產物,不該出現在使用者的下載清單裡。
4. **撞名一律加序號,不覆蓋也不跳過**(`outputs_common.unique_path`)。
   覆蓋會毀掉 copy manifest 剛複製進來的正本,跳過則是「使用者要了檔案卻什麼都沒拿到」。
5. **只收資料,不收程式。** manifest 是 JSON 或純文字清單,後端照著組檔;收程式碼等於讓模型在主機上執行任意程式。

還有一條:**降級要出聲**。載不到中文字型、清單讀不出來、超過上限而截斷 ——
這些都要回一則訊息。只寫 log 的話使用者拿到的是一份看起來正常、其實不完整的檔案。

順序也有意義:`copy manifest` → 子資料夾攤平 → `sheetgen` → `pdfgen`
→ `slidegen` → **`zipgen` 最後**(上面幾支產出來的檔案也要包得進去)。

### 交付主機上已經存在的檔案

使用者常問「把這支程式給我」,那不能靠 Write 把內容重打一遍 —— 一支幾萬行的原始檔,
模型吐不完,就算吐得完也不保證一字不差;開放 `cp` 給它又太寬。所以走
`agent.apply_copy_manifest`:claude 用 Write 寫一份 `__copy__.txt` 清單(一行一個絕對路徑),
**真正的複製由後端做**,而且只接受這一題這個專案的 `code_roots` / `knowledge_dirs`
底下的檔案(順便擋掉 `/etc/passwd` 這種東西被塞進清單)。被擋下來的路徑會用 `notice`
事件告訴使用者原因,不會整題失敗。

### 子資料夾裡的檔案會人間蒸發

`list_output_files` 只掃第一層,下載網址 `/api/files/{session_id}/{檔名}` 也沒有放路徑的位置。
所以 claude 只要寫成 `outputs/{session_id}/報表/a.csv`,那個檔案就**完全不會出現在下載清單裡**。
提示裡雖然叫它不要建子目錄,但那是規則不是機制 —— 機制在 `agent.flatten_output_dir`,
收尾時把子目錄裡的檔案搬回第一層(撞名加序號)。

### PDF 的中文:不內嵌字型

走 Adobe 的 CJK 標準字型 `MSung-Light`(Adobe-CNS1,繁體),由閱讀器自己替換。
這是刻意的:內嵌要在 repo 裡放一份十幾 MB 的 `.ttf`,而主機上有沒有中文字型無法保證。

## 寫檔權限與串流的兩個坑

### `disallowedTools` 不能放 `Edit`

**Claude Code 的 `Edit` 規則是「所有會改檔案的工具」的統稱,`Write` 也算在裡面**,
而拒絕清單優先於允許清單 —— `CLAUDE_DISALLOWED_TOOLS` 放了 `Edit`,等於一邊開放
`Write(outputs/.../**)`,一邊又把它整個關掉。症狀是 claude 回「請在提示視窗按允許」——
但 `-p` headless 模式根本沒有提示視窗。所以預設是 `CLAUDE_DISALLOWED_TOOLS=NotebookEdit`。

不放 `Edit` 不會讓它可以亂改檔案:`--allowedTools` 本身就是白名單,不在名單上的工具
在 `-p` 模式下沒有人能批准,一樣被擋。

另外路徑規則走的是 **gitignore 語法**,所以 `/home/...` 是「專案根目錄起算」而不是
檔案系統根目錄 —— 真正的絕對路徑要寫成 `//home/...`(兩個斜線)。`agent.py`
相對、絕對、`Write(...)`、`Edit(...)` 四種組合都給,少一種就可能整個對不上。

### 單行 64 KiB 上限

`asyncio` 的 StreamReader 預設一行最多 64 KiB,超過 `readline()` 會丟
`ValueError: Separator is not found, and chunk exceed the limit`。而 claude 的
stream-json **一行就是一個事件**,附了圖片(base64)或讓它讀了一支完整的大檔
(`tool_result` 會把整個檔案內容帶回來)時,一行破好幾 MB 是常態。

症狀很好認:**第一次傳檔案一定失敗,按重試就過了** —— 重試走 `--resume`,
檔案內容已經在 session 裡,不會再產生那一行巨大的 `tool_result`。

解法在 `agent.py`:`create_subprocess_exec(..., limit=STREAM_LINE_LIMIT)` 把上限拉到
16 MB,而且 readline 還是丟 `ValueError` 時只跳過那一行(失敗時緩衝區會被清掉,
可以直接接著讀),不要讓整題死掉 —— 那種超大行幾乎都是 tool_result,不是答案本身。

## 檔案區:一組對話一個,同名的收成版次

`GET /api/conversations/{id}/files`,前端在輸入框那排的「檔案 N」按鈕(沒有檔案就不出現)。

**為什麼需要它。** 檔案是按 `session_id` 分資料夾存的,而 `session_id` 是**每一題**
一個,不是每組對話一個 —— 一組對話問十題,檔案就散在十個資料夾。

**同名檔案是這個功能真正要解的問題。** 同一組對話裡叫 AI 產出三次「規格書.docx」,
三份會落在三個不同的資料夾,所以**舊的不會被蓋掉**(好事)——但攤平列出來就是三個
一模一樣的檔名,共用的同事分不出哪個新。所以版次由後端算完(`versions[0]` 一定是目前版本)。
**版次跨 upload/output 一起編**:使用者上傳一份、叫 AI 改完再產出同名檔案,對他而言就是同一份
東西的兩版,分開編的話清單上會同時出現兩個「目前版本」。

> ⚠️ **版次要照「第幾題」排,不能照檔案時間排。** `agent.apply_copy_manifest` 用
> `shutil.copy2`,它**會連來源的 mtime 一起複製** —— 交付一支兩年前改過的原始檔,
> 照時間排的話這份剛拿到的會被排成「舊版本」。同理,**顯示的時間要取
> `max(mtime, 那一題的時間)`**,不然畫面上會說這份剛交付的檔案是兩年前的。

畫面上**依「第幾題」分組**,不是依檔名 —— 人在找檔案時記得的是「我那次問完之後
它給了我什麼」。分組在顯示層做(`frontend/src/lib/conversationFiles.ts` 的 `buildFileView()`),
後端仍然回依檔名分組的版次資料。同名檔案的舊版各自待在自己那一題的框裡,所以舊版整列要調淡、
掛「舊版本」標籤、並寫出「第 N 題有更新的版本」—— 少了這些,誤下載到舊檔的問題就回來了。

> ⚠️ 那段轉換**不放在 `FilesDialog` 裡**:它算出來的那條清單,訊息串裡的附件也要用 ——
> 點回答底下的檔案要開的是**同一條**,左右切換才走得遍整組對話。兩邊各算一份的話,
> 燈箱的索引會對不起來。

**清單以資料庫欄位為準,不掃磁碟。** `uploads/{session_id}/` 底下除了原檔案還有一份
`{原檔名}.txt`(`save_upload` 對 Office 檔抽出來的文字)。掃磁碟的話使用者會在
「報價單.xlsx」旁邊看到一個莫名其妙的「報價單.xlsx.txt」。磁碟只用來拿大小與寫出時間,
順便確認檔案還在不在 —— **不在的要標成「已失效」而不是從清單消失**,
悄悄消失的話使用者會以為系統把他的檔案吃了。

> ⚠️ 用 `stat.st_mtime` 當時間時一定要轉成 **naive UTC**
> (`datetime.fromtimestamp(mtime, timezone.utc).replace(tzinfo=None)`)。
> 直接 `fromtimestamp()` 拿到的是主機本地時間,序列化出去一樣沒有時區標記,
> 而前端的 `parseServerTime` 會替所有裸時間補 `Z` —— 在 UTC+8 就是整整八小時。

**共用不需要額外同步。** 這份清單照 `conversation_id` 查、權限走 `_visible_records`,
所以共用的同事拿到的跟原作者一模一樣。前端的重抓時機掛在「已經跑完的題數」上,
不是 `displayTurns` 本身 —— 拿後者當依賴的話,串流期間每多一個字就打一次 API。

**`qa_records.asked_by` 記的是真正送出的人。** `owner` 在共用對話裡永遠是原作者
(見 `ask.py` 的 `record_owner`),拿它顯示上傳者,同事傳的檔案會被標成原作者的名字。
`asked_by` 是 NULL 的舊紀錄退回顯示 `owner`。

檔案區是唯讀的:不能打包成 zip、也不能刪檔案。

## 側邊欄資料夾

對話可以拖進資料夾歸類,資料夾可改名、可巢狀(資料夾拖進資料夾)。

**歸類是每個人自己的**(`conversation_folders` / `conversation_folder_items`,
都掛 username):同一組共用對話,甲放「簽核問題」、乙放「待處理」,互不影響 ——
所以所有資料夾查詢都必須帶 `username == viewer`,少了它就是拿到 id 就能動別人的歸類。

**刪資料夾刪的是歸類,不是對話**:裡面的對話退回時間分組、子資料夾接到上一層。
對話的刪除有自己的路徑與確認框,兩件事不能混。搬動要擋環(把 A 拖進 A 的子孫底下),
前後端都有檢查(後端是 `routers/folders.py` 的 `_would_cycle`)—— 前端先擋是為了不送一個注定失敗的請求。

拖曳是**長按拖曳**(`components/useLongPressDrag.ts`,pointer events 自己做),不是 HTML5 DnD:
HTML5 的 draggable 在手機瀏覽器上等於沒有,而且對話列本身是連結,一按下去就開始拖的話,
想點開卻手抖一下就被拖走。資料夾裡的對話選單多一條「移出資料夾」當退路。

共用成員(`ConversationSummary.share_members`,擁有者排第一,由
`routers/conversations.share_members()` 保證)由清單 API 一起帶,不在 hover 時逐組查;
清單本來就 8 秒輪詢,顯示的永遠是近況。只在 hover 才看得到的資訊,名單同時要寫進列上的
`sr-only` 文字,不然報讀軟體的使用者永遠拿不到。

## 在對話裡 @ 同事(便條)

輸入框打 `@ming 這個簽核你熟,幫我看一下`,送出之後:ming 被拉進共用、他的小夥伴
跳出「阿華 @你:這個簽核你熟,幫我看一下」、對話裡留下一則便條 ——
而 **claude 完全不知道有這回事**。

**為什麼不進 claude。** 這則的收件人是人。混進提示裡的話,claude 會很認真地去解讀
「@ming」是什麼欄位代號,並且把它當成問題的一部分來回答。

**為什麼是獨立一則便條,而不是「順便在問題前面加一句」。** 喊人最需要的時機,正好是
**問題還在跑的時候**(十幾分鐘,你想找人一起看)—— 而那時 `/api/ask` 會被
「同一組對話同時只跑一題」的 409 擋掉。便條走 `POST /api/conversations/{id}/notes`,
不建立 QARecord、不佔 claude session、不計成本,也不受那個限制。

### 便條可以夾附件,而那跟問題的附件是兩條路

輸入框裡有附件時 @ 人,附件會**跟著便條一起送給對方**,在便條泡泡裡顯示,claude 從頭到尾讀不到。
存放沿用 `uploads/{sid}/` 那套與現成的 `/api/uploads` 下載路由,但 `sid` 是替這則便條配的隨機 id
(`conversation_notes.attachment_sid`),**不掛在任何一題底下** —— 掛了的話,檔案區會把它算成
那一題的附件,「跳到這則對話」也會跳錯地方。

便條附件**也進檔案區**,但自成一格:`ConversationFileVersion.qa_id` 是 None、
改填 `note_id`,顯示成「便條 · 誰」。版次照樣跨題一起編(`turn` 放「它前面那一題的題號」
當時間錨點)—— 便條在第 3 題之後補了一版「規格書.docx」,那一版就要壓過第 3 題那版成為目前版本。

> 這條路由同時收 JSON(`{text}`)與 multipart(text + files),**手動解析而不是宣告成
> pydantic 參數**。部署時前端每次請求從磁碟讀、後端要重啟才換,交接空窗裡一定有
> 「舊前端(送 JSON)+ 新後端」;宣告成 multipart 的話,那段時間所有純文字便條都會 422。
> 前端也對稱:沒附件維持送 JSON,讓「新前端 + 舊後端」的純文字便條照樣能送。

### 判斷「有沒有 @ 到人」的規則兩邊必須一模一樣

`backend/app/notes.py` 的 `_MENTION` 與 `frontend/src/lib/mentions.ts` 的 `MENTION`
是同一條正規式,改一邊就要改另一邊。不一致的症狀很難聯想:前端判斷「這則有 @ 人」
就走便條那條路,後端卻解析不到任何人而回 400,使用者看到「送出失敗」,而他明明就打了 @。

規則是「`@` 前面**不能**是 `[A-Za-z0-9_.@-]`」,而**不是**「前面必須是空白或開頭」:
**中文打字不會在 @ 前面空一格** ——「請@ming看一下」「麻煩@jim確認」必須算數,
而判不出的後果不是少通知一個人,是**整句話被當成問題送給 claude**。負向 lookbehind 讓中文緊接
與 email(`user@example.com` 的 `@example` 前面是 `r`)兩邊都成立。後面也不能再接帳號字元
(中文字算 word 字元,不能用 `\b`)。

對不上帳號的 `@xxx` 一律當普通文字(打錯字很常見,不該讓整則送不出去);一個人都沒
@ 到時後端回 400 並把便條刪掉 —— **這一定要講出來**,不然使用者以為通知出去了。

### 選人浮層不是裝飾

@ 對到的是**帳號名**,不是顯示名稱。同仁腦子裡記的是「阿明」,打 `@阿明` 對不上任何
帳號,那則會被當成普通問題送給 claude。所以輸入框打 `@` 與按 @ 按鈕打開的是**同一個選人浮層**
(`MentionPicker`),挑中後插入帳號,讓他永遠選到對的那個字串。

偵測到這則會通知人時,輸入框上緣會明說「這則會通知 X、不會送給助理」。
**要在送出之前講**:事後才發現「我問的問題沒送出去」最糟,而那時他已經在等答案了。

### 未讀狀態是每個人各自一份

`conversation_notes` 存內容,`conversation_mentions` 存「送給誰 + 看過了沒」。
一則便條 @ 了三個人,甲看過不代表乙看過 —— 狀態塞回便條那張表的話三個人會共用一個旗標。

`ConversationMention` 有兩個時間欄位,不能合成一個:

| 欄位 | 意思 | 誰在用 |
|---|---|---|
| `notified_at` | 小夥伴的氣泡**彈過了** | 決定下一輪要不要再講一次 |
| `seen_at` | 使用者**真的打開了**那組對話 | 側邊欄每組對話的未讀數字 |

合併的話未讀數會在氣泡一跳完就歸零 —— 氣泡跳出來只代表通知送到了,他可能正在忙、根本沒點進去。

輪詢走 `GET /api/mentions/pending`,一次回傳「要彈的」與「未讀數」兩件事,不要拆成
兩個請求。未讀數**每一輪都更新**,跟有沒有新氣泡無關 —— 他可能在另一個分頁讀掉了。

未讀數字掛在**側邊欄那組對話的那一列**(`ConversationSummary.unread_mentions`),
不是小夥伴頭上的一顆總數 —— 總數只告訴人「有 2 則沒讀」,他還是不知道**該點哪一組**。
開啟對話即標已讀(`POST /api/conversations/{id}/mentions/read`);`mark_read` 回傳 `marked`,
前端**只在它大於 0 時**通知側邊欄重抓 —— 無條件通知會跟「側邊欄更新 → 對話頁重抓 → 再標一次已讀」
繞成無限迴圈。

**每一次被 @ 都會通知**,不管對方是不是早就在共用名單裡、是不是對話的原作者 ——
@ 的日常用途正是「喊一聲」。

### 通知的佇列

通報走 `sharedWatch.ts` 輪詢(8 秒,分頁在背景不打)。**被 @ 的人同時也會被拉進共用,
所以兩邊都會觸發** —— 那一輪要先把「有人 @ 我」的那幾組對話 id 收成一個集合,共用通知再把它們
濾掉,不然同一件事會講兩遍,而且先講的是資訊比較少的那句。

兩種通知還必須**走同一條佇列、一句講完才講下一句**。氣泡只有一個,各自 `petSay()` 的話
後講的會把前一句直接蓋掉。多則提及錯開 `SPEECH_MS` 一則一則講,**每則要「講完那一則才回報
那一則」**(`POST /api/mentions/announced`)—— 一次把整批標成已通報的話,使用者在輪到之前
關掉分頁,那些話就再也不會出現。代價是下一輪輪詢會把還沒輪到的那幾則再撈一次,所以另外用
`queued` 記著已經排進佇列的 id,不然同一則會被講兩遍。

**便條要算進 `ConversationSummary.updated_at`。** 側邊欄的輪詢比對的就是那個值,
不算的話「有人 @ 我」對前端而言完全沒有動靜。

> ⚠️ 側邊欄的變動偵測**不能只比對 `updated_at`**。同事按了「離開共用」之後,
> 對話內容一個字都沒變,但它已經從「共用」區變回一般對話了。`sharedWatch` 的簽章要把
> `shared_with_me` / `shared_out` / `shared_by` / `running` 一起算進去。

### 幾條邊界

- **@ 到對話的原作者時,不要把他加進共用名單。** 那是他自己的對話;替他建一列
  `ConversationShare` 的話,他自己的對話會被歸到側邊欄的「共用」區、標成「來自 XXX 分享的」。
  **通知照發。**
- **同事名單撈不到時要擋住送出,不能默默當成問題。** 便條判斷是拿 `/api/shareable-users`
  的清單比對出來的,那條失敗時清單是空的 —— 使用者打「@ming 這個你看一下」會被**整句當成問題
  送給 claude**。所以撈失敗要單獨記一個旗標(不能用「清單是空的」判斷,那跟「只有你一個帳號」
  長得一模一樣),看到疑似 @ 的字樣(`looksLikeMention`)就擋下來並說明原因。
- **`NoteOut.mentioned_names` 由後端給,前端不要自己查。** `/api/shareable-users` 會把「自己」
  排除掉,所以被 @ 的人打開時查不到自己的顯示名稱。讀這個欄位時要用 `?.`:部署時中間那段是
  「新前端 + 舊後端」,欄位會是 undefined,少了 `?.` 整個對話頁會被 ErrorBoundary 接走。

## SSH 終端機:側邊欄的 SSH Server

工程師(職稱 Software engineer)與管理員的側邊欄多一列 `SSH Server`(`/ssh`),點主機就以
`.env` 裡設定的帳號連進去,畫面是 xterm.js 終端機 + 左邊一欄 SFTP 檔案(拖拉上傳、下載、刪除)。
不用的話 `.env` 不填憑證就不會出現。沒有 `backend/terminal_hosts.json` 時清單上只有一台,名字叫「主機」
(就是 `.env` 的 `SSH_TERMINAL_*` 那一台,id = `main`);要多台再照 `backend/terminal_hosts.example.json`
複製一份 `terminal_hosts.json`(不進版控,密碼只放 `.env`,json 裡填 `password_env` 指名)。
⚠️ **有這個檔就以它為準,是整份取代、不是追加**(`config.terminal_hosts()`):`.env` 的 `SSH_TERMINAL_*`
那一台不會自動加進來,要的話自己在檔裡寫一筆。

每台主機的 logo 是 `frontend/public/host-logos/<id>.jpg`(16:9,主機卡片)與 `<id>-tall.jpg`(3:4,連線方框)。
範本沒附圖,放了同名的圖就會顯示,沒有就顯示名稱的第一個字。`public/` 在 build 時複製進 `dist/`,
所以放好圖要重新 build(Docker 版是重建 image)。

**為什麼走真的 SSH,不是在服務裡直接開 shell。** 服務跑在受限的環境裡(Docker 版是 `cap_drop: ALL`、
`no-new-privileges` 的容器),直接 fork 出來的 shell 只看得到容器、權限也少一截;asyncssh 連到目標主機的
sshd 拿到的是一模一樣的登入 session,sshd 自己的登入紀錄照留,檔案欄的 SFTP 也走同一條連線。
asyncssh 是純 Python,所以整段橋接在 Windows 開發機上就能對著一個假 sshd 跑整合測試
(`backend/tests/test_terminal_bridge.py`),不需要 WSL / Docker。

**憑證怎麼放。** 全在設定檔的 `SSH_TERMINAL_*`(開發版 `backend/.env`、Docker 版 `askme.env`;
完整說明見 `deploy/env.server.example`),瀏覽器**不能**指定任何一項。建議用金鑰:一對 ed25519,
公鑰加進目標帳號的 `authorized_keys`(目標是本機的話限 `from="127.0.0.1,::1"` —— 外洩了也只能從主機自己登入自己),
再用 `ssh-keyscan` 產一份 known_hosts(服務**只認這份**,對不上就拒連)。Docker 版兩個檔都放進
`deploy/docker/ssh/`(步驟見那裡的 README)。金鑰與密碼都沒設 = 功能視為關閉:開機 warning 一次、側邊欄不顯示那一列。

**權限與稽核。** 能不能開終端機跟 Bash 權限是**同一個來源**(`auth.can_use_terminal` → `users.is_power_user`):
改職稱就同時給 / 收回。憑證放在 .env 之後,網站登入(帳密 + MFA)就是唯一一道門,所以這一條與稽核比什麼都重要:
WebSocket 的第一個訊息要帶 token、`Origin` 要跟 Host 同一台、沒有權限的帳號直接連會拿到 4403 + 一筆 `terminal_denied`。
稽核記 `terminal_connect` / `terminal_disconnect`(含持續秒數與結束原因)/ `terminal_file_upload` /
`terminal_file_delete` 等;**不記鍵盤輸入與畫面內容**(那會把 `su` 密碼一起記進去),也不記下載與列目錄。
這些事件**後端照記、安全頁不顯示**(見「安全頁」那節),要查就看 `audit_log`。

**上限在哪調。** 每人同時最多 `SSH_TERMINAL_MAX_SESSIONS` 條(預設 4,用頁籤開;滿了拒絕新的,**不踢舊的**);
閒置 `SSH_TERMINAL_IDLE_TIMEOUT_SEC`(預設 0 = **閒置不斷線**;前端 3 分鐘沒操作會蓋上螢幕保護,那不是斷線。
填了秒數才會斷,而那時**純輸出不算活動**,`tail -f` 放著一樣會斷);
連線逾時 `SSH_TERMINAL_CONNECT_TIMEOUT_SEC`(10 秒);上傳大小走 `MAX_REQUEST_MB`。
`SSH_TERMINAL_KEEPALIVE_SEC`(預設 240)一個值管兩段線:給瀏覽器那段讓 nginx 看到有流量,
給主機那條 SSH 當 keepalive_interval。
前面有 nginx 的話,`/api/terminal/ws` 要另一個 location 送 `Upgrade` 標頭,`proxy_read_timeout` 要大於 keepalive
(填了閒置逾時的話也要大於它)(見 `deploy/nginx.conf.example`),不然閒著的連線會被 nginx 先切掉、
使用者看到的原因會是錯的。

**檔案欄。** 只刪檔案與**空**資料夾,非空的回 400:沒有回收桶,一個誤點刪掉整棵目錄樹是修不回來的;
真要刪整棵樹,終端機就在旁邊。不支援重新命名與新建資料夾。下載 / 刪除在檔案欄的工具列,吃多選。
**檔案欄跟著終端機的目前目錄走**:開 PTY 前後各看一次 `/dev/pts` 認出這條連線的 tty、再每秒讀一次
`/proc/<shell>/cwd`,**不改主機上的任何設定**(不動 `.bashrc`、不送 `PROMPT_COMMAND`);認不出來就靜靜地不追蹤。

**旁邊那顆 AskME。** 終端機右上角那顆**品牌 logo** 打開右邊的面板:它讀得到你畫面上的內容,
回答問題,但**沒有任何工具** —— 不執行指令、不讀寫主機上的檔案、不上網(`backend/app/terminal_ai.py`
把工具名字全列進 `--disallowedTools`,而且不掛任何 `--add-dir`)。要執行的指令它只會寫給你,自己貼。
送出去的**固定是畫面上看得到的那一段**;稽核只記「誰在幾點問了一次」(`terminal_ai_ask`),
問題與畫面內容一個字都不記。它走同一支 claude CLI(模型看 `TERMINAL_AI_MODEL`),
但**不寫 qa_records**,所以 /stats 的用量不含它。面板標題、工具列那顆鈕、選字之後浮出來的那顆鈕,
三處都叫 **AskME**,後端會顯示在面板上的錯誤訊息也是。

**本機示範。** Windows 上沒有 sshd,`backend/dev_terminal_demo.py` 在**一個行程**裡起一個假 sshd
(行編輯的回音 shell + chroot 的 SFTP,`127.0.0.1:2222`)加整套服務(port 8124、暫存 SQLite、MFA 關、
管理員帳密寫在那支檔案開頭)。`.claude/launch.json` 的 `backend-demo` + `frontend-demo`
(`node frontend/dev-demo.mjs`,把 /api 轉到 8124)就是這一組。只給看畫面用,不要部署。

## Work Flow:排程拼圖

在畫布上把「連線 → 同步程式 → 執行腳本 → 通知人員 → 中斷連線」接起來,存檔、設排程,
後端照排程經 SSH 在主機上跑。要用的話:

```bash
cp backend/workflow_actions.example.json backend/workflow_actions.json
# 改裡面的指令:每個連線對象的 vpn_up / vpn_down(建立 / 拆掉連線的一般 shell 指令)、
# sync(rsync,一定要有 {delete});然後重啟服務
```

重啟之後工程師 / 管理員的側邊欄就會多一列 Work Flow。瀏覽器永遠送不了指令:每塊拼圖跑什麼只寫在這個檔,
畫面上只能選清單裡的哪一個、填目錄或腳本路徑(後端先過白名單)。這個檔**不進版控**、裡面不放密碼;
沒有這個檔的時候 `/api/workflows` 一律 404、排程器不啟動、`/workflow` 是找不到頁面。
欄位說明寫在範本檔的 `_comment`。
本機看畫面:`backend/dev_terminal_demo.py` 會自己寫一份指向假指令的 `workflow_actions.json`,示範站就有 Work Flow。
