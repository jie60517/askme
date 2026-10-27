# 登入與安全

帳號、登入、MFA、鎖定、地理封鎖,以及幾道擋在路由前面的安全機制。


## 個人帳號與對話隔離

**一律要登入。** 沒有匿名模式,沒登入什麼都看不到、也問不了。
**新增任何讀得到 `QARecord` 的路徑時,依賴一律掛 `auth.require_user`,不要掛
`auth.current_user`** —— 後者沒登入回 `None` 而不是報錯,只該給 `/api/me` 用。

過濾做在後端(`routers/conversations.py` 的 `visible_to`),每一條會讀到 `QARecord`
的路徑都要經過它 —— **漏掉任何一條,那條路徑就等於沒有隔離**。

> ⚠️ `owner` 是 `NULL` 的紀錄(沒有掛在任何帳號名下)沒有任何一般帳號看得到。資料沒有被刪掉,
> 只是不出現在任何人的清單上。要把某一批指給某個人,直接 `UPDATE qa_records SET owner=... WHERE ...`。

**帳號不分大小寫,但身分一律用「系統存的那個寫法」。** 登入框會把輸入即時轉小寫
(手機鍵盤預設會把首字母變大寫),後端則用 `users.resolve()` 把打進來的字對回資料庫存的大小寫,
再拿它發 token。

> ⚠️ 這件事不能只做前端。帳號名同時是**資料的擁有者**(`qa_records.owner`、
> 共用名單、資料夾),拿使用者打的字當身分的話,`Ming` 會登入成功卻看不到自己的
> 任何一組對話 —— 那些的 owner 是 `ming`。新帳號一律以小寫建立,而且用
> 不分大小寫的方式檢查重複:真的建出 `ming` 與 `Ming` 兩列的話,resolve 只會挑到
> 其中一個,另一個的對話從此沒有人看得到。
>
> 登入失敗的計數器也要用小寫當 key(見 `routers/auth.py`)。照使用者打的字分開記的話,
> `ming`/`Ming`/`MING` 各有各的額度,帳號層的鎖等於不存在。

前端在 `App.tsx` 那層也擋了一道:身分還沒確定前只顯示骨架,確定沒登入就只渲染
登入頁,側邊欄／命令面板／小夥伴整組都不掛上去。那不是安全機制(真正的隔離在後端),
是因為那些元件各自都會打 API,掛上去只會送出一串必定 401 的請求,而 401 會被
攔截器清掉 token —— 等於自己把剛登入的狀態洗掉。

帳號由管理員在「帳號管理」頁(`/users`)建立/停用/刪除,沒有自助註冊,
也沒有任何檔案版本的帳號清單 —— 帳號只在資料庫的 `users` 表,全新的資料庫
由管理員登入後建第一個帳號。`.env` 的 `ADMIN_USERNAME` 是管理員(他不在
`users` 表裡,密碼在 `.env`),只有他看得到管理頁:用量統計、安全、帳號管理。

⚠️ **這道隔離擋的是「從網頁上看到別人的對話」**,不是資安等級的隔離:資料庫密碼
就在主機上的設定檔裡,服務也跑在服務帳號身分,任何能 SSH 進主機、以那個帳號讀檔的人
都直接連得上資料庫讀全部內容。不要對同仁講得比實際更強。

## 關掉瀏覽器就要重新登入

**三個地方一起才成立,少一個這個要求就是假的:**

| 在哪 | 做什麼 |
|---|---|
| 前端 | token 存 `sessionStorage`,不是 `localStorage`(`frontend/src/lib/auth.ts`) |
| 後端 cookie | 下載用的 cookie 是 session cookie(沒有 `max_age`) |
| 後端 token | **閒置逾時** `AUTH_IDLE_TIMEOUT_SEC`(預設 60 分鐘) |

⚠️ **前兩個必須一起。** 只做前端的話,關掉瀏覽器再開會變成「畫面要重新登入,
但 `/api/files` 那三條路徑照樣通」—— 權限殘留,而且畫面上完全看不出來。

⚠️ **第三個是後盾,不是可有可無的。** 前兩個全都在瀏覽器那一側,而瀏覽器的
「回復上次工作階段」會把 sessionStorage 與 session cookie **一起帶回來**。
關著的瀏覽器不送請求,閒置計時就不會被推後,所以這個值就是「關掉之後最多還能被救回來多久」。
網頁本身每 8 秒在輪詢,分頁開著就一直算在使用,60 分鐘不會踢到正在讀答案的人。
絕對上限 `AUTH_TOKEN_TTL_SEC`(預設 12 小時)不受影響 —— 一直用也不會變成永久登入。

`sessionStorage` 是**每個分頁各自一份**,所以「在新分頁開啟連結」預設是未登入。
為此有**跨分頁交接**:新分頁透過一個 localStorage 鍵開口要,還開著的分頁把 token 遞過去
(寫進去同一個 tick 就刪掉)。全部分頁都關掉之後就沒有人可以遞,那正是要的行為。

## 多因子驗證(TOTP):管理員發放

模型是「管理員發、使用者掃」,**不是自助綁定**。使用者那一側**沒有任何入口**。

| 動作 | 在哪 |
|---|---|
| 發給某個人 | 帳號管理頁(`/users`)那一列的選單 →「產生 QR code」 |
| 他手機壞了 / 換手機 | 同一顆,再按一次(**舊的當場失效**) |
| **發給管理員自己** | 同一頁**最上面那張獨立的卡片** ↓ |
| 還有誰沒發 | 帳號管理頁的「手機驗證」欄 |

⚠️ **管理員自己要另外一塊。** 他不在 `users` 表裡(密碼在 .env),所以 `/api/users` 那份清單
**沒有他**。少了那張卡片,權限最大的帳號永遠發不到 QR,「全面強制」也開不起來
(他自己會被自己擋在門外)。那張卡片走的是 `/api/admin-account`。

⚠️ 發放時會把那個人**其他地方的登入全部踢掉**(手機被偷的情境下這是必要的),
但**保留操作者自己這一張** —— 不留的話,管理員發給自己會在按下去的同一秒被登出,
那張還沒掃的 QR 當場消失。

**沒有「單獨解除綁定」這個動作。** 需要它的情境只有離職,而那走的是刪除帳號
(會一併清掉綁定)。「解除」跟「重新產生」相鄰的話,強制模式開著時誤點就是把人擋在門外。

發完之後那個人登入會多一步:密碼過了先拿到一張**只能換 token 的中間憑證**
(壽命 `MFA_CHALLENGE_TTL_SEC`,預設 5 分鐘),輸入手機上那組 6 位數才換得到真正的 token。

- **演算法是自己實作的**(`backend/app/totp.py`,標準庫),沒有裝 pyotp。
  RFC 6238 的測試向量在 `tests/test_mfa.py` 裡守著。
- **QR 用 `qrcode` 這個 npm 套件在前端畫**,不碰網路。QR 底下**保留手動輸入的金鑰** ——
  掃不到的情況很常見。QR 的底寫死白色、不跟深色模式走,深色底很多 App 掃不到。
- **重放要擋**:用過的 30 秒計數器記在 `user_mfa.last_counter`。
  ⚠️ 重新產生時**要把它清掉**,不然新密鑰的前幾組碼會被舊計數器擋下來,
  而使用者只看到「驗證碼不正確」。
- **沒有備用碼。** 復原路徑只有一條(管理員重新產生)。
  ⚠️ 所以**登入頁不可以出現「用你的備用碼」那種字** —— 照著做只會連錯幾次然後把自己的帳號鎖 15 分鐘。
- `MFA_ISSUER` 是驗證器 App 裡顯示的名字,綁定之後不要改(App 是在綁定當下記下名字的)。

### 全面強制:`MFA_REQUIRED`

預設**關閉**。關著的時候只有已經發過 QR 的人需要輸入六碼,其他人照舊只用密碼。
開著的時候,沒發過的人**一律登不進來**(密碼對也一樣)。

⚠️ **順序不能反。** 先開再發的話,那一瞬間所有人都登不進來 —— 包含管理員自己。
正確順序:**先發給管理員自己**(最上面那張卡片)→ 發完每個同仁 →
確認大家都掃過並登入過一次 → 才把 `MFA_REQUIRED=1` 寫進 `.env` 並重啟。

**弄反了服務會直接起不來。** `init_database()` 有一道防呆:旗標開著、而管理員
自己還沒綁定就 `RuntimeError`,訊息裡寫著怎麼救。那個狀態沒有任何出路(所有人都被 403 擋掉,
而唯一能發 QR 的人就是管理員),讓服務起來反而更糟。帳號管理頁最上面那張卡片會直接告訴你
**現在是強制還是過渡**,不用去翻 `.env`。

⚠️ 這個旗標**刻意不用 `_env_enabled`**:那一支是給「預設開」的開關用的,
預設關的安全開關誤開就是破洞(`tests/test_files_auth.py` 會抓到)。

### 在公司就不用輸入六碼:`MFA_SKIP_ON_TRUSTED_IP`

預設**關閉**。開著的時候,來源落在 `LOGIN_IP_ALLOWLIST`(公司的對外 IP,見「登入失敗的鎖定」)的登入
**整個跳過第二關**:綁了 MFA 的人不必輸入六碼,`MFA_REQUIRED` 也不擋還沒發過 QR 的人。
**所有帳號都適用,包含管理員。** 信任的來源就是 `LOGIN_IP_ALLOWLIST`,不是另一份設定 ——
兩份公司 IP 遲早會漂掉。

⚠️ **這是拿安全換方便,而且換掉的正好是 MFA 唯一在擋的那件事 ——「密碼已經外洩」。**
開了之後,任何連得上公司網路的人(訪客 Wi-Fi、被入侵的內網電腦、借出去的筆電)
只要有密碼就能登入。

每一次跳過都在稽核留下一筆 `login_mfa_skipped_ip`(「公司 IP 免驗證碼」)—— 事後查「這次登入
到底過了幾關」只有這一個依據(安全頁不顯示這一種,見「安全頁」)。

⚠️ 症狀對照:**在公司還是要輸入六碼** = `client_ip()` 沒拿到真 IP
(`FORWARDED_ALLOW_IPS` 或 `LOGIN_IP_ALLOWLIST` 填錯)。方向是安全的那一邊,
但**不要為了「修好它」把 nginx / 容器的位址填進白名單** —— 那等於全世界都免第二關,
還順手把 IP 層的封鎖一起關掉。

### 有人被鎖在門外的時候

**一般帳號** —— 管理員在帳號管理頁按「重新產生 QR code」。他原本的登入會一起被踢掉。

**管理員自己** —— 沒有網頁上的救法(他登不進來,就打不到那支 API)。要直接刪資料庫裡那一列,
而且**順序不能只做刪除那一步**:

1. 先把設定檔的 `MFA_REQUIRED` 改成 0 並重啟(開發版改 `backend/.env` 重開 uvicorn;Docker 版改
   `askme.env` 再 `docker compose up -d --force-recreate askme`)。⚠️ 少了這一步,下一步刪完就是
   「服務起不來」—— 上面那道防呆(旗標開著 + 管理員沒綁定 → RuntimeError)正好會被這個狀態觸發。
   旗標本來就是 0 的話跳過這步。
2. 刪掉管理員那一列綁定(username 換成你的 `ADMIN_USERNAME`):

   ```bash
   # 開發版在 backend/ 底下用 .venv 的 python;Docker 版在 deploy/docker 底下把開頭換成 docker compose exec askme python
   .venv/Scripts/python -c "
   from sqlalchemy import text
   from app.database import engine
   with engine.begin() as c:
       c.execute(text(\"delete from user_mfa where username='<管理員帳號>'\"))"
   ```

3. 用密碼登入 → 在帳號管理頁最上面那張卡片重新產生 QR code 並掃描
4. 確認掃過、也用六碼登入過一次之後,才把 `MFA_REQUIRED` 設回 1 並重啟

第 4 步要真的做完,不然強制那一層就一直是關的,而畫面上不會有人提醒你。

開發版用 venv 的 python:`app.config` 一被 import 就會 `load_dotenv()`,所以 .env 的
DATABASE_URL 自動生效,不用自己 source(密碼含 `$`、`#` 時 shell 的 source 會壞)。
Docker 版的 `DATABASE_URL` 由 compose 給,`exec` 進去一樣拿得到。Postgres 或 SQLite 都是同一段。

## 登入失敗的鎖定

`/api/login` 是唯一能被硬撞的路徑(其他路徑要 token,而 token 是 256 bits 隨機值),
所以限制只做在那裡。兩層分開算,任何一層滿了就 429(見 `app/ratelimit.py`):

| 層 | 門檻 | 怎麼解開 | 擋什麼 |
|---|---|---|---|
| 帳號 | 失敗 5 次(`LOGIN_MAX_ATTEMPTS`) | 15 分鐘後**自動**(`LOGIN_LOCKOUT_SEC`),或管理員在 `/security` 解開 | 針對某個人硬猜 |
| 來源 IP | 失敗 10 次(`LOGIN_IP_MAX_ATTEMPTS`) | **永久,只能管理員在 `/security` 解除**(寫進資料庫,重啟後還在) | 拿字典掃全部帳號(每個帳號各試幾次,永遠碰不到帳號層) |

**兩層的解鎖方式刻意不一樣,因為它們擋的是不同的人。** 打錯自己密碼的多半是同事
本人,不該讓他卡著等人處理 —— 而且鎖帳號本身就能被當成攻擊(知道某個帳號存在的人
故意打錯五次就能把他鎖住),自動解開的話最壞情況只是等一下。反過來,同一個來源在
**不同帳號上**累積失敗 10 次,那不是打錯字,是有人在掃。

**驗證碼打錯算進帳號層,但刻意不算 IP 層。** 不記帳號層的話,第二關就是一個
不限次數的猜測入口(六位數只有一百萬種組合);而記進 IP 層的話,六位數打錯是家常便飯
(手機時鐘差幾秒、看到上一組碼),同一間辦公室的人又常常共用一個對外 IP,幾個人各打錯幾次
就一起被**永久封鎖**。走到第二關的人已經證明他有正確的密碼,他不是在掃帳號。

永久封鎖在 API 與前端都用 `retry_after = -1` 表示(`ratelimit.PERMANENT`)。
`Retry-After` 標頭只在真的等得到時才送 —— 送 `-1` 是不合法的標頭值。

登入成功會清掉**該帳號**的計數,但**故意不清 IP 的** —— 清了的話,攻擊者只要
自己有一組合法帳密,靠「每失敗幾次就登入自己的帳號一次」就能把 IP 計數洗掉。

**被 429 擋掉的嘗試也要算進 IP 那層**(`record_blocked_attempt`)。少了這一步,
對**同一個帳號**猛撞,第 5 次就把帳號鎖了,之後每一次都在 `check()` 就被回絕、走不到
`record_failure` —— IP 計數永遠停在 5,撞五十次也不會被封鎖。實際節奏(對單一帳號連續打錯):

```
第 1~5 次   401  帳號或密碼錯誤        ← 第 5 次把帳號鎖了
第 6~10 次  429  請在 15 分鐘後再試     ← 這幾次仍然累進 IP 計數
第 11 次    429  這個來源已被封鎖       ← IP 永久封鎖
```

**代價:硬要一直重試的人會把自己的 IP 鎖掉。** 正常人看到「請在 15 分鐘後再試」會停手;
真的誤鎖了,管理員在「安全」頁(`/security`)按一下就解開。覺得太嚴就把 `LOGIN_IP_MAX_ATTEMPTS` 調高,
或 `LOGIN_IP_LOCKOUT_SEC` 填秒數改回自動到期。即使是永久模式,IP 的**失敗計數**仍然有 15 分鐘的
有效視窗,不然一個偶爾打錯字的人累積幾個月也會被永久封鎖。

**管理員沒有豁免**,因為管理員帳號是最有價值的目標。管理員可以在「安全」頁解鎖別人。

**IP 層的封鎖寫進資料庫(`login_ip_blocks`),重啟後還在。** 落地的只有**鎖上的那一刻**,
失敗計數仍然只在記憶體 —— 每次失敗都寫一列的話,猛撞就變成一條往硬碟塞東西的路。
帳號層維持記憶體(它 15 分鐘就自己解)。開機時 `main.py` 會把仍在封鎖中的 IP 載回記憶體,
log 印一行「載回 N 個仍在封鎖中的 IP」。

所以「重啟服務就全部解開」不成立,取而代之的是**唯一的白名單**:

```bash
# backend/.env(Docker 版是 askme.env)—— 公司的對外公網 IP,逗號分隔,吃單一位址也吃 CIDR
LOGIN_IP_ALLOWLIST=<公司出口 IP>,<第二條線的 IP>
```

⚠️ **實際的值只填在部署那台的設定檔,不要寫進版控。** 它是一份「哪些來源免疫」的清單,
寫進 repo 等於把防禦設定跟著程式碼一起發出去;公司換線路時,版控裡那份也會變成過期資料。

名單裡的來源**連失敗計數都不記**,所以永遠不會被 IP 層鎖住。帳號層照樣會鎖,
公司內網一樣不能無限猜密碼;地理封鎖也不看這一份(那一關的例外是下面的境外白名單)。
⚠️ 這份名單**管兩件事**:除了免 IP 層鎖定,開了 `MFA_SKIP_ON_TRUSTED_IP=1` 之後,
從這裡來的登入還會**免第二關**。加一個 IP 進來之前要知道兩件都會發生。
名單是事後才加的也立刻生效,而且開機載回時會把白名單裡的那幾列順手刪掉
(「公司被鎖了,趕快把公司 IP 加進白名單」是最可能發生的情境)。

⚠️ 要填的是公司出口的**公網位址**,不是 `FORWARDED_ALLOW_IPS` 那個 nginx / 容器位址 ——
填那個等於把全世界放進白名單,IP 層直接失效。查法:在公司網路開瀏覽器連 <https://ifconfig.me>;
或翻 `audit_log`(帳號數最多、跨度最長的那個來源就是公司出口):

```bash
# 開發版在 backend/ 底下;Docker 版在 deploy/docker 底下把開頭換成 docker compose exec askme python
.venv/Scripts/python -c "
from sqlalchemy import text
from app.database import engine
with engine.connect() as c:
    for ip, n_actor, n in c.execute(text(\"select ip, count(distinct actor), count(*) from audit_log where event like 'login%' group by ip order by 3 desc limit 6\")):
        print(f'{ip:18} {n:5}次 {n_actor:2}個帳號')
"
```

真的把自己鎖在門外又不在公司:在設定檔把當下的 IP 加進 `LOGIN_IP_ALLOWLIST` 再重啟,
開機載回時會跳過白名單裡的 IP 並刪掉那一列,等於順手解鎖。三條救法寫在
`app/routers/locks.py` 檔頭。

### 客戶端 IP 是 uvicorn 還原的

前面放了 nginx 的話,客戶端 IP 是 **uvicorn** 還原的,不是我們的程式:uvicorn 的
`--proxy-headers` 只在來源位址落在 `FORWARDED_ALLOW_IPS` 時,才照 `X-Forwarded-For` /
`X-Forwarded-Proto` 把 `request.client` 與 scheme 換成真的。nginx 跟 uvicorn 在同一台、同一個網路空間時
`FORWARDED_ALLOW_IPS=127.0.0.1` 就對了;**Docker 版**的 askme 在容器裡,看到的來源是容器網段的位址
(nginx 裝在主機上是 compose 網路的閘道,nginx 也在容器裡是那個容器的位址)——
那時 `askme.env` 的 `FORWARDED_ALLOW_IPS` 要填那個位址(`deploy/env.server.example` 有查法),容器重建時要重查。
沒有 nginx、同仁直接連 `<主機 IP>:8100` 的話,這一條不用管。

- `TRUST_PROXY_HEADER` **留空**:它讓程式自己讀標頭、不看來源,服務聽在 `0.0.0.0:8100`,
  同網段任何人都能繞過 nginx 直連並自填 IP,鎖定形同虛設,還能拿別人的 IP 打錯十次鎖掉對方。
- `FORWARDED_ALLOW_IPS` 填錯的後果:後端看到的每個請求都來自同一個來源,所有人共用一個
  計數器,任何路人打錯 10 次就把所有人(含管理員)擋在外面。改完先看服務 log 的來源位址。

## 登入的地理封鎖

`GEO_BLOCK_MODE` 一個設定三種值,**沒有第二個開關**(兩個布林互相搭配的寫法打錯一個字就會靜默翻面,
而翻錯邊就是全員鎖死):

| 值 | 行為 |
|---|---|
| `off` | 什麼都不做(預設) |
| `dryrun` | 只記錄不擋,稽核寫一筆 `login_geo_dryrun` |
| `enforce` | 真的擋 |

填別的值**服務會拒絕啟動**,不會當成關閉。判定用 APNIC 公布的台灣網段,離線查表、不打外部服務
(`backend/app/geoip.py`,清單 `backend/tw_ranges.txt`,用 `backend/build_tw_ranges.py` 重建)。
政策是 **fail-closed**:判得出是台灣才放行,**判不出來也擋**(`geoip.is_allowed`)。
例外是內網 `172.16.0.0/12` 放行,**但落在 `FORWARDED_ALLOW_IPS` 裡的位址照擋**
(不然 nginx 容器在那一段時,`FORWARDED_ALLOW_IPS` 沒生效的請求會全部被當成內網放行)。

⚠️ **開之前一定要先跑 `dryrun`,而且先確認 `FORWARDED_ALLOW_IPS` 是對的。** 填錯的話,
`client_ip` 會對所有人回 nginx 自己的私有位址 → 判不出來 → **一個人都登不進來**。
上線順序:`dryrun` 跑幾天 → 用 `GET /api/audit?all_events=1` 查有沒有 `login_geo_dryrun`,
有的話先查清楚是誰(出差的同仁?某條線路走境外出口?)→ 乾淨了才換 `enforce`。

⚠️ **前面有 nginx 時,同仁走的入口是 nginx 的網域,不是 `<主機 IP>:8100`。** 直接打後者會**繞過 nginx** —— 沒有
`X-Forwarded-For`,`client_ip()` 只拿得到內網的私有位址,開了地理封鎖的話登入回 **403**
「這個連線來源不允許登入」,而 `/api/health` 照樣通過。SSH 通道進來的 `127.0.0.1` 也一樣。

### 出差:安全頁的「允許登入的 IP」(不必重啟)

`enforce` 之下非台灣的來源一律登不進來。出差的同仁到**安全頁的「允許登入的 IP」**加一條:
填他在當地的對外 IP,**下一次登入就通,不必改 `.env`、不必重啟**。回國後在同一頁刪掉。
名單存在資料庫(`geo_allow_ips`),每次登入現查。增刪都寫稽核(`geo_allow_added` / `geo_allow_removed`)。

這一塊畫面上只有 IP 一欄。

⚠️ **它只免地理那一關。** 密碼照驗,綁了 MFA 的人照樣要輸入六碼 —— 白名單放行的是
**來源**不是**人**(那個 IP 上的任何帳號都能過地理這一關),正因為門開得寬,第二關更不能跟著免。
免第二關的是公司自己的 IP,兩份名單刻意分開。

擋下來的填法(後端會回一句中文,見 `app/geo_allow.py`):

- `0.0.0.0/0` / `::/0` —— 等於把地理封鎖關掉,而畫面上它還是「啟用」。要停用請改 `.env`。
- 太大的網段(v4 比 `/16` 大、v6 比 `/32` 大)。要放行更多就分成幾條加。
- 不是對外位址的(內網、CGNAT、文件用的 `203.0.113.x`)。**前面有 nginx 卻看到內網位址,
  代表 `FORWARDED_ALLOW_IPS` 設錯了** —— 那時候把它加進白名單等於一次替全世界開門。

## 安全頁

`/security`(管理員)。「最近的事件」**只顯示登入這一類**:成功、失敗,以及「密碼沒問題卻沒進來」
的幾種(被鎖、被地區擋、驗證碼錯、沒綁驗證器)—— 見 `routers/audit.py` 的 `SHOWN`。
其他事件(帳號、職稱、終端機、Work Flow、白名單增刪、境外白名單放行、公司 IP 免驗證碼、地區封鎖試跑)
**後端照記、畫面不顯示**,事後查「誰刪了帳號、誰改了權限」用 `GET /api/audit?all_events=1`
(管理員,照 `_CATEGORIES` 分類)或直接查資料庫的 `audit_log`。
`login_mfa_challenged`(密碼對了、還沒過第二關的中間狀態)連 `all_events` 也預設不列,
要看帶 `?include_challenges=1`。

## 檔案下載為什麼要一個 cookie

`/api/files`、`/api/uploads`、`/api/preview` 這三條**要登入**,而且認證收的是
一個 HttpOnly cookie(`auth.SESSION_COOKIE`),不是只有 `Authorization` 標頭。
原因是瀏覽器的硬限制:下載是 `<a href>`、縮圖是 `<img src>`,這兩種標籤**帶不了標頭**。

⚠️ **隱晦不是權限。**「`session_id` 是 uuid4().hex,猜不到」擋得住亂試的人,
擋不住網址被複製、貼進聊天室,或留在瀏覽器紀錄與 nginx 的 access log 裡。

- cookie 跟 token 是**同一串**,不是第二種身分:登出、改密碼作廢的是同一張表。
- `Path=/api`、`SameSite=Lax`、`HttpOnly`;只有連線是 https 時才加 `Secure`
  (內網直連 `http://…:8100` 時硬加的話瀏覽器不收,縮圖與下載會全 401)。
- `/api/me` 每次都會把 cookie 補發一次(不會延長登入)。
- **要登入之外還要「看得到那組對話」。** 三條路由都先過 `files.py` 的
  `_require_visible_session()`,拿到網址但不在可見範圍的同仁一樣拿不到檔案。
  `session_id` 有兩種來源,兩條都認:一題問答的 `QARecord.session_id` 套
  `conversations.visible_to`;一則便條的 `attachment_sid` 先找出它屬於哪組對話,
  再問 `shares.can_access`。

  ⚠️ **判斷不自己寫**,一律套那兩個既有的唯一出入口 —— 在這裡多寫一份
  「owner 等於自己或在共用名單裡」的話,哪天共用規則改了就會分岔,而分岔的那一邊
  是「檔案還下載得到」。
  ⚠️ **不過的一律回 404,不回 403。** 403 等於告訴對方「這個 session_id 存在,
  只是你不能看」。找不到對應紀錄的(對話已刪、只剩磁碟上的殘檔)同樣是 404。

## 靜態檔案的路徑一定要驗證

`main.py` 的 `serve_frontend` 是全站唯一一條「拿網址去組檔案路徑」的地方,所以它
**必須**把組出來的路徑 `resolve()` 之後確認還在 `frontend/dist` 底下。
少了這道檢查就是**未經登入的任意檔案讀取**(`/../../backend/.env`,網址編碼的 `..%2f` 一樣通),
在主機上等於讀得到服務帳號讀得到的任何東西,包括 `~/.claude` 的憑證。

> 測這條不能用瀏覽器:**瀏覽器會自己把 `../` 正規化掉**。要用 `http.client` 這種可以送
> 原始路徑的東西(`deploy/security_test.py` 就是這樣測的)—— 攻擊者不用瀏覽器。

同一個道理適用於 `routers/files.py`。**任何從請求取值去組路徑的地方,都要照這個模式做。**

## 密碼怎麼存

`pbkdf2_sha256$<迭代數>$<鹽>$<雜湊>`,600,000 次迭代(OWASP 對 PBKDF2-SHA256 的
建議值),每一列自己的鹽。一次比對要幾百毫秒 —— **慢是刻意的**,那同時也是線上猜密碼的成本。

`users.verify` 也認得無鹽單輪的 `sha256:<hex>` 格式,登入成功時就地把它升級成上面的 pbkdf2
(那是唯一拿得到明文的時刻)。⚠️ 升級**不動 `password_changed_at`** —— 那欄的意思是「他自己改過密碼」,
寫下去的話還在用預設密碼的人會被當成已經改過,強制改密碼那道就對他失效了。
回歸測試:`backend/tests/test_password_hashing.py`。

⚠️ `is_default_password()` 跑在 `auth.require_user` 裡,**每一支需要登入的 API
都會呼叫**。所以它先看 `password_changed_at`:有值就直接回 False,不做那次比對。
這條捷徑成立的前提是「`change_password` 擋掉了改成預設密碼」—— 拿掉那道檢查,這裡就會開始說謊。

`DEFAULT_USER_PASSWORD` 是管理員建帳號 / 重設密碼時發下去的那組;沒設的話建帳號與重設密碼會被拒絕。

## 站在路由前面的兩道閘:請求大小與安全標頭

兩個 ASGI 中介層在 `backend/app/security.py`,由 `main.py` 掛在所有路由之前。

**請求本文大小**(`BodySizeLimit`)。FastAPI 對帶 `Form`/`File` 的端點是**先把整個
body 讀完(multipart 的檔案 spool 到 /tmp)再跑 `Depends`**,也就是 `require_user`
排在讀 body 之後 —— 匿名者送幾 GB,授權那一步永遠跑不到,/tmp 已經滿了。所以在
ASGI 層看 `Content-Length`(沒有就邊收邊數)直接 413:沒帶任何憑證的請求上限
`ANON_MAX_REQUEST_KB`(64 KB,登入的 JSON 用不到 1 KB),帶著**有效**憑證的
`MAX_REQUEST_MB`。⚠️ 憑證要**真的驗**(`security._has_valid_credential`:Bearer token
與 session cookie 都拿去查 `auth._tokens`、確認沒過期),不能只看標頭有沒有帶
—— 只看有沒有帶的話,匿名者加一行 `Authorization: Bearer x` 就拿到大的上限。
nginx 的 `client_max_body_size` 是第一道,這是第二道(內網直連 8100 也擋得住)。
配套:`MAX_UPLOAD_FILES` 限一個請求幾個檔(不然單檔 50 MB 的上限等於沒有),
`MIN_FREE_DISK_MB` 硬碟剩太少就整批拒收。

**安全標頭**(`SecurityHeaders`)。每個回應都帶 `X-Content-Type-Options: nosniff`、
`X-Frame-Options: SAMEORIGIN`(不能是 DENY:PDF 預覽是同源 iframe 嵌 `/api/uploads/...`)、
`Referrer-Policy: same-origin`、`Permissions-Policy`;https 連線上再加 HSTS 一年 ——
https 是 uvicorn 從 nginx 的 `X-Forwarded-Proto` 還原的,前提有兩個:nginx 有送那個標頭,
**而且** nginx 的來源位址在 `FORWARDED_ALLOW_IPS` 裡 —— 少了任一個,HSTS 不會出現、
登入 cookie 也不會標 Secure(症狀:CSP 有、HSTS 沒有)。

**CSP** 的 `script-src` 只放 `'self'` 加 `dist/index.html` 那段 inline script 的 hash ——
hash 是**啟動時算的**,前端改了那段不用來後端同步;本機只跑後端、沒有 dist 時就不送 CSP。
`style-src` 放 `'unsafe-inline'`(StyleX 與 framer-motion 會寫 inline style;XSS 要擋的是 script)。
改 CSP 之後要真的開瀏覽器看 console:違規不會讓後端報錯,只會讓前端某個功能靜靜壞掉。

nginx 那一側要做的事(版本號不外露、登入端點限速、body 上限、HSTS)在
`deploy/nginx.conf.example`(選配,見 [operations.md](operations.md))。

## CORS 只給本機開發

`CORS_ORIGINS` 留空 = **完全不掛 CORS 中介層**,而那正是正式機該有的樣子:
前後端由同一個 uvicorn 端出去、同一個 origin,瀏覽器不會問。本機開發才要填
(vite 5173 → 後端 8123 是跨 origin,`backend/.env.example` 已經填好)。

⚠️ **不要寫 `allow_origins=["*"]`。** 現在可利用性低(token 走 Authorization 標頭、
沒開 `allow_credentials`),但哪天有人加上 `allow_credentials=True`,`*` 當場就變成
「任何網站都能用使用者的身分打這個 API」。
