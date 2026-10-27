from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text

from .database import Base


class QARecord(Base):
    __tablename__ = "qa_records"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    session_id = Column(String, unique=True, index=True)
    conversation_id = Column(String, index=True, nullable=True)

    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=False)

    uploaded_filename = Column(String, nullable=True)
    output_files = Column(Text, nullable=True)  # 逗號分隔的檔名清單

    # claude 回答這一題時實際讀過/搜尋過的東西,JSON 陣列字串:
    # [{"tool": "Read", "target": "src/orders/service.py", "detail": null}, ...]
    # 存起來的用意是事後看得出這個答案到底有沒有根據程式碼,
    # 還是模型憑印象掰的 —— 光看答案文字分不出來。
    sources = Column(Text, nullable=True)

    # 這題問的是哪個專案(knowledge_bases.json 的 id)。
    # 同一個檔名在不同專案裡內容不一樣,事後對照答案時得知道該拿哪一棵程式碼樹,
    # 不然沒辦法判斷答案對錯。
    knowledge_base = Column(String, nullable=True, index=True)

    # 這則問答屬於誰(登入時的帳號名稱)。問答一律要登入,所以程式寫入的列一定有值;
    # NULL(「公開池」,見 config 的「個人帳號」那段)沒有人看得到。
    #
    # 每個人只看得到 owner 等於自己的,加上分享給他的(shares.can_access)。
    # 過濾一律做在後端(conversations.py),不要只在前端藏 ——
    # 只在前端藏的話,知道網址就直接看得到別人的對話,那不叫隔離。
    owner = Column(String, nullable=True, index=True)

    # 實際送出這一題的人。**跟 owner 不是同一件事**:共用對話由別人續問時,owner 掛的是
    # 原作者(見 ask.py 的 record_owner),所以光看 owner 認不出這個附件是誰傳的 ——
    # 在共用的檔案區裡會把同事上傳的檔案標成原作者的名字,那比不顯示還糟。
    #
    # NULL = 送出的人就是 owner。
    asked_by = Column(String, nullable=True)

    # running / done。送出的當下就會先寫一筆 running 的紀錄,claude 跑完才更新成 done。
    #
    # 這樣做是為了讓「關掉分頁、重新整理、換一台電腦」都不會弄丟正在跑的那一題:
    # 紀錄從第一秒就存在,對話清單跟歷史都查得到,回答內容由 runs.py 的背景 task 補上。
    # 服務重啟時殘留的 running 會在 main.py 啟動時收尾成失敗(見 close_orphan_runs)。
    status = Column(String, default="done", index=True)

    #: 使用者刪掉了這組對話的時間。NULL = 沒刪。
    #:
    #: **為什麼是軟刪除。** 管理員的用量統計是從這張表算的,整列刪掉會連帶把
    #: 成本、token、誰問的一起帶走,**統計數字整段對不上**,而且沒有任何線索。
    #: 帳要留得住,就不能讓內容的生命週期決定帳的生命週期。
    #:
    #: ⚠️ **刪除仍然是真的刪除**:`delete_conversation` 在標記的同時會把
    #: `question` / `answer` / `sources` / 附件欄位清成空字串。留下來的只有
    #: 「誰、什麼時候、花了多少」這幾個數字 —— 統計要的就是這些,而使用者
    #: 按刪除要的是內容消失。兩邊都成立。
    #:
    #: 讀取端的規矩:**每一條給使用者看的路徑都要濾掉它**。主要出入口是
    #: `conversations.visible_to`,但**它不是唯一的一個** —— `shares.owner_of`
    #: 與 `ask.py` 裡那兩處(current_kb、舊 session 的回退)也各自濾一次,
    #: 理由更硬:漏掉的話,拿舊網址對一組已刪的對話續問會被判定成「你就是原作者」,
    #: 而 claude 那側還會 `--resume` 回原本的 session,把使用者以為刪掉的內容
    #: 整段讀回模型的上下文裡。新增讀取路徑時要一起想這件事。
    #:
    #: 管理員的用量統計**刻意不濾** —— 那正是這個欄位存在的理由。
    deleted_at = Column(DateTime, nullable=True, index=True)

    success = Column(Boolean, default=True)
    error = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    cost_usd = Column(Float, nullable=True)


class QAStep(Base):
    """一題問答的**流水帳**:claude 每呼叫一次模型、每碰一次工具,這裡就多一列。

    **為什麼要跟 `QARecord.sources` 分家**,而不是把欄位加在那個 JSON 裡:

      `sources` 是**給使用者看的**「執行過程」,它**去重**(見 agent.py 的
      `seen_sources`)—— 同一個檔讀三次只會出現一次。而「同一個檔被讀了三次」
      正好是查成本問題時最想看到的那個訊號,去重之後就永遠看不到了。
      兩邊的用途相反:一個要乾淨,一個要完整,所以不能共用同一份資料。

    **token 記在「輪」上,不是記在「工具」上** —— 這是刻意的,不是偷懶:

      一次模型呼叫(一輪)可能同時發出好幾個工具呼叫,帳是整輪一起算的,
      沒有辦法誠實地拆給個別工具。硬拆出來的數字看起來很精確,但它是編的。

      真正能歸給工具的是**下一輪的 `input_tokens`**:那一輪的輸入裡沒有命中
      快取的部分,幾乎就是上一輪那些工具的結果被讀進來的量。所以看「這個工具
      貴不貴」要看它下面那一輪的 input,查詢端會算好(見 routers/stats.py)。

    ⚠️ **不記每一步的美金**。CLI 只在最後的 result 給一題的 `total_cost_usd`,
    要拆到每一輪就得在後端維護一張各模型的價目表 —— 那張表一定會過期,過期之後
    畫面上的數字會錯得看不出來。token 是事實,錢留在題的層級。

    FK 帶 `ON DELETE CASCADE`:用 bulk delete(不經過 ORM)刪 qa_records 時,
    ORM 層的 cascade 設定不會生效,只有資料庫自己的 cascade 才擋得住。
    少了它會直接撞 FOREIGN KEY constraint failed(連線有開 foreign_keys)。
    """

    __tablename__ = "qa_steps"

    id = Column(Integer, primary_key=True, index=True)
    qa_record_id = Column(
        Integer, ForeignKey("qa_records.id", ondelete="CASCADE"), index=True, nullable=False
    )

    #: 這一題裡的第幾步,從 0 開始。**照發生順序,不去重**。
    seq = Column(Integer, nullable=False)
    #: 屬於第幾輪模型呼叫。工具列跟發動它的那一輪共用同一個 turn,
    #: 畫面上才能把工具收在該輪底下(一輪呼叫好幾個工具是常態)。
    turn = Column(Integer, nullable=False, default=0)

    #: turn    = 一次模型呼叫(token 記在這種列上)
    #: tool    = 一次工具呼叫(token 欄位留 NULL,理由見上面)
    #: subturn = 子代理(Task)裡面的模型呼叫。它一樣要花錢,但不是主線的一輪,
    #:           混在一起算會讓「主線跑了幾輪」這個數字失真。
    kind = Column(String, nullable=False, default="tool")

    tool = Column(String, nullable=True)
    target = Column(Text, nullable=True)
    #: 沒縮短、沒截斷的標的。`target` 為了聊天頁的「參考來源」砍掉了樹根
    #: (`/srv/myproject/src/x.py` → `src/x.py`),Bash 還截在 120 字 —— 在明細頁
    #: 那等於「看不出是哪一棵樹」「指令後半段不見了」。
    #:
    #: ⚠️ **舊資料是 NULL** —— 前端要退回 `target`,
    #: 不要顯示成空白(那會被讀成「這一步沒碰任何東西」)。
    target_full = Column(Text, nullable=True)
    detail = Column(Text, nullable=True)

    #: 從這一題開始算過了幾毫秒。用相對值不用絕對時間,跟 sources 的 at_ms 同一個
    #: 理由:耗時是相減出來的,相對值不會被前後端時鐘差影響。
    #:
    #: ⚠️ **這是「第幾毫秒發生」,不是「花了多久」** —— 兩者是不同的量,
    #: 拿相鄰兩列的 at_ms 相減也得不到耗時(理由見 duration_ms)。
    at_ms = Column(Integer, nullable=True)

    #: 這一步真正花了多久(只有工具列會有)。
    #:
    #: ⚠️ **不能用 at_ms 相減算出來。** `content_block_stop` 是「模型把這通呼叫
    #: **寫完**了」,工具是在整則 assistant 訊息結束之後才執行的 —— 所以相鄰兩個
    #: tool_use 的 at_ms 差量到的是模型吐字的速度,不是工具的耗時。
    #: 真正的耗時是 tool_use 寫完到對應的 `tool_result` 回來之間那一段,
    #: 由 agent.py 用 tool_use_id 配對量出來。
    #:
    #: 沒等到 result 的(被停止、逾時)留 NULL —— 那是事實,不要補 0。
    duration_ms = Column(Integer, nullable=True)

    #: claude 給這通工具呼叫的 id。它是 tool_result 回來時唯一對得起來的鍵,
    #: 存下來是為了事後對照 CLI 的日誌 —— 光有路徑對不出是哪一次呼叫。
    tool_use_id = Column(String, nullable=True)

    #: 這一輪用了哪個模型。同一題中途換模型是有可能的(子代理常跑小模型),
    #: 不記的話事後看到一輪特別便宜會以為是快取命中。
    model = Column(String, nullable=True)

    #: 沒命中快取、真的重新讀進去的輸入。**這是要盯的那個數字。**
    input_tokens = Column(Integer, nullable=True)
    #: 命中快取的輸入。它很便宜,而且越大代表快取越有效 —— 這個數字沒有變大,
    #: 就代表提示的固定前綴有東西在逐題漂動
    #: (見 docs/architecture.md〈prompt cache:不能讓快取前綴每題都變〉)。
    cache_read_tokens = Column(Integer, nullable=True)
    #: 寫進快取的輸入(第一次要付較貴的價錢,之後才划算)
    cache_creation_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)


class User(Base):
    """使用者帳號。只存在這張表(沒有檔案版本)—— 為了能在網頁上管理 + 留變更軌跡。

    管理員(.env 的 ADMIN_USERNAME)**不在這張表**:它的密碼在 .env,不走這套。
    """

    __tablename__ = "users"

    username = Column(String, primary_key=True)
    # `pbkdf2_sha256$<迭代數>$<鹽>$<雜湊>`;不接受明文。由 users.py 統一處理
    password = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    # "full" = 完整工具(含 Bash);NULL / 其他 = 唯讀。
    tools = Column(String, nullable=True)
    # 停用的帳號登不進去,但資料與軌跡都留著,可再啟用。刪除才是真的移除。
    disabled = Column(Boolean, default=False, nullable=False)
    # 畫面上的職稱(@ 選單的副標)。NULL = 用 users.DEFAULT_ROLE。
    # ⚠️ **它就是權限**(users._FULL_ROLES):上面那個 tools 是由 role 推導出來的
    # 快取欄位,不要再從別的地方寫它。
    role = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    created_by = Column(String, nullable=True)  # 誰建的(管理員名)
    # 上次改密碼時間(內稽內控)。從沒改過(還是預設密碼)留 NULL。
    password_changed_at = Column(DateTime, nullable=True)


class AuditLog(Base):
    """內稽內控的事件軌跡。只記「發生過什麼」,不刪不改 —— 稽核紀錄一旦能被竄改就失去意義。

    第一梯隊(認證/存取)的事件:
      login_success   登入成功
      login_failed    登入失敗(actor 是「被嘗試的帳號」,可能根本不存在)
      login_blocked   被 IP 鎖定擋下的登入嘗試
      password_changed 使用者改了自己的密碼
      password_change_failed / password_change_blocked  改密碼時目前的密碼打錯 / 錯太多次被擋(跟登入共用帳號層計數)

    帳號管理(routers/admin_users.py)的事件:
      account_created / account_deleted   建立、刪除帳號
      account_disabled / account_enabled  停用、啟用
      role_changed                         改職稱(= 改權限,detail 會寫明後果)
      password_reset                       管理員重設密碼
    """

    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    event = Column(String, index=True)
    # 這件事是誰做的(帳號名)。登入失敗時是「被嘗試的帳號名」,不保證是真帳號。
    actor = Column(String, nullable=True, index=True)
    ip = Column(String, nullable=True)
    # 補充說明,人看的自由文字(例如失敗原因、變更了什麼)
    detail = Column(Text, nullable=True)


class ConversationMeta(Base):
    """對話的額外資訊,用 conversation_id 對應,不是每組對話都會有。"""

    __tablename__ = "conversation_meta"

    conversation_id = Column(String, primary_key=True)
    custom_title = Column(String, nullable=True)

    # claude 那邊的 session id,跟我們自己的 conversation_id 分開存。
    #
    # 不能拿 conversation_id 直接當 claude 的 session id:只要有一次「claude session
    # 建好了、問答紀錄卻沒寫成」(串流被中斷、使用者切走、後端重啟都會 ——
    # GeneratorExit 會砍掉子行程,commit 就沒跑到),下次重試就會判定成新對話而
    # 重複下 --session-id,claude 直接回「Session ID ... is already in use」,
    # 那組對話從此卡死。
    #
    # 分開存的話:只有「真的完成過一輪」才會寫進這裡,沒寫成就下次配一個全新的
    # session,不會撞。
    claude_session_id = Column(String, nullable=True)

    # 上面那個 session 是在**哪個工作目錄**建出來的。
    #
    # claude 的 session 檔存在 ~/.claude/projects/<工作目錄代號>/ 底下,所以
    # `--resume` 一定要回到當初那個 cwd,換了目錄就是「查無此 session」,
    # 那組對話會從此每次續問都失敗。
    #
    # NULL 代表「當初用的是共用的 CLAUDE_WORKDIR」—— 續問時就照那個走,
    # 不要拿它現在選的專案去推,不然那些既有對話會一起斷掉。
    workdir = Column(String, nullable=True)


class UserPref(Base):
    """個人偏好。目前只有主題,但獨立一張表有個非做不可的理由:

    **管理員不在 users 表裡**(密碼在 .env,見 users.py 開頭的說明)。把偏好掛在
    users 上的話,唯一一個天天在用帳號管理與安全頁的帳號反而記不住自己的設定。
    這張表用 username 當主鍵,誰都存得下,跟 users 表沒有外鍵關係。
    """

    __tablename__ = "user_prefs"

    username = Column(String, primary_key=True)
    # "light" / "dark"。沒有這一列或值是 NULL = 沒設過,前端沿用本機的。
    theme = Column(String, nullable=True)

    # ── 個人顯示設定 ──────────────────────────────────────────────────
    #
    # ⚠️ 頭像存的是 **data URI 字串**(`data:image/jpeg;base64,...`),不是檔案路徑。
    # 選資料庫而不是檔案:備份資料庫就連頭像一起備,
    # 不會出現「還原之後每個人的頭像都不見了」。前端上傳前縮到 256px(約 20~40KB),
    # 後端再擋一次大小(見 users.set_avatar)。
    avatar = Column(Text, nullable=True)
    # 字級百分比。100 = 原本大小。NULL = 沒設過。
    font_scale = Column(Integer, nullable=True)
    # 對比強度百分比。100 = 佈景原本的對比。NULL = 沒設過。
    contrast = Column(Integer, nullable=True)
    # 常用模型("sonnet" / "opus",不含 haiku)。NULL = 沒設過,前端用
    # `lib/modelPref.ts` 的預設(sonnet)。
    # ⚠️ **不做外鍵也不做 CHECK**:合法值是 `config.ALLOWED_MODELS`,而那是
    # 環境變數決定的(同一份資料庫可能被設定不同的機器讀到)。驗證放在
    # `users.set_display_prefs`(字級/對比/模型同一支),讀出來時前端也會再對一次
    # allowed_models —— 寫死在資料庫裡的話,哪天加一個模型就要改結構。
    preferred_model = Column(String, nullable=True)
    # 右下角的吉祥物("classic" / "blob")。NULL = 沒設過 = classic。
    # 合法值在 `users.COMPANIONS`,同樣不做 CHECK(加一隻就不必改結構)。
    companion = Column(String, nullable=True)
    # Bloub 的型態與顏色。NULL = 沒設過 = 圓形 + 跟著佈景(auto)。
    # 合法值在 `users.COMPANION_SHAPES` / `COMPANION_COLORS`,理由同上不做 CHECK。
    # 選 classic 時也留著 —— 切回 Bloub 還是原本那個樣子。
    companion_shape = Column(String, nullable=True)
    companion_color = Column(String, nullable=True)


class ConversationShare(Base):
    """把一組對話分享給某個帳號。

    複合主鍵(對話 + 對象),所以同一組對話分享給同一個人兩次不會產生第二列 ——
    重複分享是很自然的操作(想不起來有沒有分享過就再按一次),不該報錯。

    **不做外鍵。** conversation_id 只存在於 qa_records 的欄位裡(沒有 conversations
    這張表),而 username 那邊管理員可以刪帳號。掛外鍵只會讓刪帳號被擋住,
    而孤兒列的代價很小 —— 那個人已經登不進來了,分享對誰都不生效。
    """

    __tablename__ = "conversation_shares"

    conversation_id = Column(String, primary_key=True)
    # 被分享的人
    username = Column(String, primary_key=True, index=True)
    # 誰分享的。用來在對方的清單上顯示「來自 王小明」,也留個軌跡。
    shared_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ConversationNote(Base):
    """對話裡給**人**看的一則便條。**永遠不會送給 claude,也不佔一則問答。**

    為什麼需要它:光把對話分享出去,對方點開只看到一串問答,不知道你要他幹嘛 ——
    「所以你是要我看哪一段?」。便條就是補這句話用的。

    它跟 QARecord 是兩種東西,所以不共用那張表:
      - 沒有答案、沒有成本、沒有 sources,不該進統計
      - 不佔 claude session,更不受「同一組對話同時只跑一題」的 409 限制
        (正在等答案的時候本來就最需要喊人)
    """

    __tablename__ = "conversation_notes"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    conversation_id = Column(String, index=True, nullable=False)
    # 誰寫的(帳號名)
    author = Column(String, index=True, nullable=False)
    # 使用者打的原文,**含 @xxx 不拿掉** —— 這則從來不會送給 claude,
    # 沒有「存的要跟送出去的一致」那個包袱,保留原文讀起來最自然。
    body = Column(Text, nullable=False)
    # 這則 @ 到誰,逗號分隔的帳號名。顯示用;未讀狀態在 ConversationMention。
    mentioned = Column(Text, nullable=True)

    # 便條夾帶的附件。**跟問答的附件是兩條路**:問答的附件會送給 claude 當上下文,
    # 便條的附件純粹是給被 @ 的人看的(截圖、報表、要對方確認的檔案),
    # claude 從頭到尾不知道有這些東西。
    #
    # 存放沿用 uploads/{sid}/{檔名} 那套(下載走現成的 /api/uploads 路由),
    # 但 sid 是替這則便條配的隨機 id,不是任何一題的 session_id ——
    # 掛在某一題底下的話,檔案區的版次規則會把它算成那一題的附件。
    attachment_sid = Column(String, nullable=True)
    # 逗號分隔的檔名清單(跟 QARecord.output_files 同一種存法)
    attachments = Column(Text, nullable=True)


class ConversationFolder(Base):
    """側邊欄的資料夾。**每個人自己的**歸類方式,跟對話本身無關 ——
    同一組共用對話,甲放「簽核問題」、乙放「待處理」,互不影響。

    parent_id 指向同一張表(巢狀)。不做外鍵,理由跟 ConversationShare 一樣:
    孤兒的代價很小,而且刪除路徑會自己把子資料夾重新掛到上一層(見 routers/folders.py)。
    """

    __tablename__ = "conversation_folders"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    # 資料夾的主人。所有查詢都要帶這個條件 —— 少了它就是拿得到別人的資料夾 id
    # 就能改名/搬動別人的歸類。
    username = Column(String, index=True, nullable=False)
    name = Column(String, nullable=False)
    # NULL = 頂層
    parent_id = Column(Integer, nullable=True, index=True)


class ConversationFolderItem(Base):
    """某人把某組對話放進了哪個資料夾。

    複合主鍵(username, conversation_id):一個人對一組對話只有一種歸類,
    再拖到別的資料夾就是覆蓋,不會累積出兩筆。
    """

    __tablename__ = "conversation_folder_items"

    username = Column(String, primary_key=True)
    conversation_id = Column(String, primary_key=True)
    folder_id = Column(Integer, nullable=False, index=True)


class ConversationMention(Base):
    """一則便條要送到誰手上,以及他看過了沒。

    跟 ConversationNote 分開是因為**未讀狀態是每個人各自一份** —— 一則便條 @ 了三個人,
    甲看過了不代表乙看過。把 seen_at 塞回便條那張表的話,三個人只會共用一個旗標。
    """

    __tablename__ = "conversation_mentions"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    note_id = Column(Integer, index=True, nullable=False)
    conversation_id = Column(String, index=True, nullable=False)
    # 被 @ 的人
    username = Column(String, index=True, nullable=False)
    # 小夥伴已經把這則彈出來過了。NULL = 還沒彈過,下次輪詢要講。
    #
    # 不記的話,他每 8 秒就會被同一則便條彈一次,一整天都甩不掉。
    notified_at = Column(DateTime, nullable=True)

    # 使用者**真的去看了**那組對話。NULL = 未讀,小夥伴頭上的數字算的就是這個。
    #
    # ⚠️ 跟 notified_at 是兩件事,不能合成一個欄位:氣泡彈出來只代表「通知送到了」,
    # 他可能正在忙、根本沒點進去。合併的話未讀數會在氣泡一跳完就歸零,
    # 那個數字就永遠是 0,等於沒有這個功能。
    seen_at = Column(DateTime, nullable=True)


class UserMFA(Base):
    """一個帳號的多因子驗證設定(TOTP)。

    **為什麼不是加在 `users` 表上。** 管理員(`config.ADMIN_USERNAME`)的密碼在
    .env,他在 `users` 裡**沒有那一列** —— 設定加在那張表上的話,唯一一個
    權限最大、最需要第二道關卡的帳號反而綁不了。獨立一張表就沒有這個例外。

    **有這一列 = 已經發過、而且已經生效。** 沒有「待確認」的中間狀態 ——
    那是自助綁定才需要的(使用者可能抄到一半跑掉),而這裡是管理員當面給人掃碼。
    所以登入那一側的判斷就是「這一列在不在」(`mfa.is_enabled`)。

    ⚠️ 既有的資料庫上這張表可能還留著 `confirmed_at` / `backup_codes` 兩個欄位,
    程式碼不讀不寫它們。SQLite 刪欄位要整張表重建,留著沒有壞處。
    **不要因為看到欄位就把它們接回來。**
    """

    __tablename__ = "user_mfa"

    #: 帳號名稱。**存的是正規化之後的大小寫**(`auth.canonical_username`)——
    #: 登入時查詢用的也是那個,兩邊不一致的話 MFA 會被當成沒啟用而直接放行。
    username = Column(String, primary_key=True)

    #: base32 密鑰。⚠️ **這是明文等價的憑證**:讀得到它就能自己算出 6 位數。
    #: 它跟密碼雜湊不一樣,沒辦法做成單向的 —— 驗證時伺服器必須算出同一組碼,
    #: 所以本來就得留著可還原的值。app.db 的檔案權限就是這個欄位的防線。
    secret = Column(String, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow)

    #: 最後一次驗證成功用掉的 30 秒計數器。**擋重放用的,不能省。**
    #:
    #: 同一組 6 位數在它那個時間窗內一直有效,不記的話,肩窺、側錄、或是
    #: 攔到那一次請求的人,在同一分鐘內可以拿同一組碼再登入一次。
    #: 比對規則在 `totp.verify`:小於等於這個值的計數器一律跳過。
    #:
    #: ⚠️ **重新發放時要清成 NULL**(見 `mfa.issue`)—— 不清的話,新密鑰的前幾組碼
    #: 會被舊密鑰留下的值擋掉,而使用者只看到「驗證碼不正確」。
    last_counter = Column(Integer, nullable=True)


class LoginIPBlock(Base):
    """被鎖定的來源 IP。**開機時載回記憶體用的,不是查詢時的真相來源。**

    鎖定要寫進資料庫、重啟後還在:IP 層的預設是**永久封鎖**,只放在 `ratelimit.py`
    的記憶體字典裡的話,等於「封到下次重啟為止」。

    ⚠️ **只記「已經鎖上」的那一刻,不記每一次失敗。** 失敗計數只在記憶體 ——
    每失敗一次就寫一列的話,對方連續打幾十萬次就是替他開了一條往硬碟塞東西的路。
    鎖上是**每 10 次失敗最多一列**,而且同一個 IP
    只會有一列(ip 是主鍵),寫入量有上限。

    ⚠️ **判斷「現在有沒有被鎖」一律看記憶體那份,不要查這張表。** 登入路徑上
    多一次查詢沒有意義,而且兩份都能回答的時候,遲早會出現只改了其中一份的路徑。
    這張表只在兩個時機被碰:啟動時載回去(`ratelimit.load_persisted_blocks`)、
    以及鎖上/解鎖的那一刻(`ratelimit` 的 `_persist_block` / `_forget_block`)。

    白名單(`LOGIN_IP_ALLOWLIST`,自家的對外 IP)的來源根本不會走到這裡 ——
    它在記次數之前就被擋掉了,所以這張表裡永遠不會出現自家的 IP。
    """

    __tablename__ = "login_ip_blocks"

    #: 來源位址,字面值。**跟記憶體那份字典的 key 是同一個東西**
    #: (`ratelimit.client_ip` 回傳的字串),所以載回去時不需要任何轉換。
    #: 不存成整數也不做正規化:v4 / v6 / `unknown` 都可能進來,而且
    #: 存什麼就封什麼,中間多一層轉換只會多一種對不起來的方式。
    ip = Column(String, primary_key=True)

    blocked_at = Column(DateTime, default=datetime.utcnow)

    #: 鎖到什麼時候(UTC naive,跟這張表其他時間欄位一致)。
    #: **NULL = 永久**,也就是 `LOGIN_IP_LOCKOUT_SEC=0`(預設)的那種,
    #: 要管理員到「安全」頁按解鎖。用 NULL 而不是一個很遠的日期,是為了讓
    #: 「永久」在 SQL 裡也看得出來 —— 拿日期硬湊的話,查的人得先知道那個魔術值。
    expires_at = Column(DateTime, nullable=True)


class GeoAllowIP(Base):
    """地理封鎖的例外:這個來源即使不在台灣網段裡,也讓它登入。管理員在「安全」頁增刪,不用重啟。

    ⚠️ **為什麼是資料庫而不是 .env 多一個變數。** 地理封鎖的其他設定
    (`GEO_BLOCK_MODE`、`TW_RANGES_FILE`)都是啟動時讀一次,改了要重啟 ——
    而臨時要放行的來源(例如出差)等不了一次重啟。
    存進這張表之後,登入路徑每次現查(`geo_allow.match`),按下新增的那一秒就生效。

    ⚠️ **不做記憶體快取。** 登入不是熱路徑(一天幾十次),而快取換來的是
    「多個 worker 各有一份、新增的白名單只有其中一個認得」——
    那種不一致的症狀是「有時候進得去有時候進不去」,查起來比省下的那次查詢貴太多。

    ⚠️ **這張表只管地理封鎖那一關,不碰別的。** 在這裡的來源照樣要過帳號密碼、
    照樣要過第二關(有綁的話)、IP 層鎖定也照舊 —— 那是 `LOGIN_IP_ALLOWLIST`
    的事,兩份名單**刻意分開**:一份是「自家的出口」(信任到免第二關),
    另一份是「暫時放行的境外來源」(出差、客戶端),把它們合成一份的話,
    加一筆出差用的白名單會順手把那個 IP 升成「內部」。
    """

    __tablename__ = "geo_allow_ips"

    #: 正規化過的網段字串,單一位址也存成 `/32`(v4)或 `/128`(v6)——
    #: 見 `geo_allow.normalize`。**存正規形式而不是使用者打的字**:
    #: `203.0.113.5` 與 `203.0.113.5/32` 是同一件事,不正規化的話會變成兩列,
    #: 而刪掉其中一列的人會以為自己關上了門。
    cidr = Column(String, primary_key=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    #: ⚠️ **沒有「誰加的」這一欄。** 這份清單只有 IP,
    #: 「誰在什麼時候開的、什麼時候關的」完整記在稽核表(`geo_allow_added` /
    #: `geo_allow_removed`,detail 是同一個正規化後的網段,而稽核沒有清除機制)。
    #: 在這裡再存一份等於同一件事有兩個來源,而其中一份沒有任何讀者。


class Workflow(Base):
    """Work Flow 的一條流程。**工程師共用**,不是每人一份。

    圖(拼圖 + 連線 + 位置)與排程都存成 JSON 文字:形狀一直會長(新的拼圖種類、
    新的設定欄位),拆成欄位的話每加一種拼圖就要一次遷移。檢查在 `workflows.normalize_*`,
    **寫進來的一定是檢查過的形狀**,讀的人不用再防。
    """

    __tablename__ = "workflows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    graph = Column(Text, nullable=False, default="{}")
    schedule = Column(Text, nullable=False, default="{}")
    #: 下一次排程時間(UTC)。存檔與每次觸發後重算;排程關掉是 NULL。
    #: 排程器只看這一欄 —— 不用每 20 秒把每條流程的排程重算一次。
    next_run_at = Column(DateTime, nullable=True, index=True)
    created_by = Column(String, nullable=False)
    updated_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)
    #: 軟刪除。執行紀錄還指著它,硬刪的話紀錄頁會出現一堆「不知道是哪條流程」的列。
    deleted_at = Column(DateTime, nullable=True)


class WorkflowRun(Base):
    """一次執行。`steps` / `events` 在執行中**每一步結束就寫一次**,
    所以服務中途重啟,紀錄會停在最後完成的那一步(`close_orphan_workflow_runs` 收尾)。"""

    __tablename__ = "workflow_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(Integer, ForeignKey("workflows.id"), nullable=False, index=True)
    #: manual / schedule
    trigger = Column(String, nullable=False)
    #: 手動的是帳號;排程的是設定排程的那個人(稽核要追得到是誰設的)。
    triggered_by = Column(String, nullable=False)
    #: running / ok / fail / stopped / skipped
    status = Column(String, nullable=False, index=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    #: 停在哪一塊的名字(例如「執行腳本」)。成功的是空字串。
    stopped_at = Column(String, nullable=False, default="")
    #: 執行當下那張圖的快照 —— 事後改了流程,舊紀錄仍然對得上當時的樣子。
    graph = Column(Text, nullable=False, default="{}")
    steps = Column(Text, nullable=False, default="[]")
    events = Column(Text, nullable=False, default="[]")


class UserNote(Base):
    """個人筆記。**只有寫的人看得到**,管理員在網站上也看不到;永遠不會送給 claude。

    跟 ConversationNote(寫給被 @ 的同事)是兩種東西,不共用表:
    這裡是「一個人可以有很多則、可選擇記下從哪一題存來的」。

    從對話存的那幾種存的是**複製一份**:原對話之後被刪或被改,筆記內容不變,
    只有「回到對話」那顆會停用 —— 所以 source_* 只是指標,不做外鍵。
    """

    __tablename__ = "user_notes"

    id = Column(Integer, primary_key=True, index=True)
    # 主人。所有查詢都要帶這個條件(同 ConversationFolder 的說明)。
    username = Column(String, index=True, nullable=False)
    title = Column(String, nullable=False, default="")
    # Markdown 原文。圖片寫成 `![](notebook-image:<UserNoteImage.id>)`,前端換成真網址 ——
    # 不把網址寫死進去,API 位置換了(本機 5173 → 8123、主機前面掛 nginx)舊筆記照樣顯示得出來。
    body = Column(Text, nullable=False, default="")
    # selection / qa / screenshot / NULL(自己寫的)。清單列首的圖示用。
    source_kind = Column(String, nullable=True)
    source_conversation_id = Column(String, nullable=True, index=True)
    source_qa_id = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # ---- 以下欄位全部 nullable
    # 編輯器自己的格式(Tiptap JSON 文字)。**有就以它為準**;NULL = 舊筆記,前端從 body(Markdown)讀。
    # 文字顏色、底線、可收合清單、提示框、圖片寬度、資料庫、留言標記都只存得進這裡;body 仍然每次一起寫(搜尋、摘要用)。
    doc = Column(Text, nullable=True)
    # 頁中頁:上一層是哪一則(同一個主人)。NULL = 最上層。不做外鍵,理由同 source_*。
    parent_id = Column(Integer, nullable=True, index=True)
    # 同一層裡的順序(小的在上面)。NULL = 還沒排過(舊資料),清單第一次讀時照「新的在上」補號。
    position = Column(Float, nullable=True)
    # 丟進垃圾桶的時間。NULL = 沒刪;30 天後真的清掉(routers/notebook._purge_trash)。
    deleted_at = Column(DateTime, nullable=True, index=True)
    # 頁面圖示(線條圖示的名字,可帶顏色「名字:顏色」)與封面圖(`notebook-image:<id>`)。
    icon = Column(String, nullable=True)
    cover = Column(String, nullable=True)
    # 全寬。NULL = 否。
    full_width = Column(Boolean, nullable=True)
    # 存成模板的那幾則:不出現在頁面清單,只在「從模板新增」裡。NULL = 否。
    is_template = Column(Boolean, nullable=True)


class UserNoteImage(Base):
    """筆記裡的圖片。檔案放 `config.NOTEBOOK_DIR/<id>.<副檔名>`,這張表記誰的、屬於哪一則、多大。

    `bytes` 存起來是為了算「每人圖片總量」不用每次去磁碟 stat。
    """

    __tablename__ = "user_note_images"

    # 隨機 32 字 hex(uuid4)—— 會出現在網址上,不要用流水號讓人猜得到下一張
    id = Column(String, primary_key=True)
    username = Column(String, index=True, nullable=False)
    note_id = Column(Integer, index=True, nullable=False)
    ext = Column(String, nullable=False)
    bytes = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
