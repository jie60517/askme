from datetime import datetime
from typing import Annotated, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .ids import FIELD_PATTERN

# 送進來的字串一律要有上限。
#
# 沒有上限時,一個請求就能把任意大小的字串寫進資料庫或拿去做雜湊 ——
# 不需要任何漏洞,照著 API 規格送就好。這些數字取「正常用途綽綽有餘、
# 但不足以拿來塞爆東西」的量級。
#
# 注意:**問題內容不在這裡限制**,它走 agent.sanitize_text(MAX_QUESTION_CHARS),
# 因為那邊要的是「截斷後照樣送出」而不是「整個請求打回」——
# 使用者貼了一大段 log 進來,截斷還能回答,退回去他只會覺得系統壞了。
MAX_CREDENTIAL_CHARS = 200
MAX_TITLE_CHARS = 200

#: 職稱在 API 上的合法值 —— **只有這兩個字串,加一個「清掉」的空字串**。
#:
#: ⚠️ 用 `Literal` 而不是 `str`:後端用字串相等判斷要不要給完整權限
#: (`users.role_grants_full`),打錯大小寫(`Software Engineer`,大寫 E)會**靜悄悄**
#: 把人降成唯讀,而畫面照樣顯示一個看起來合理的職稱。`Literal` 讓打錯字直接 422。
#:
#: ⚠️ **空字串不能拿掉** —— `PATCH /api/users/{u}` 的契約是「帶空字串 = 清掉職稱」
#: (存 NULL,讀的那側退回 `users.DEFAULT_ROLE`),路由靠 `model_fields_set`
#: 分辨「沒帶」和「帶了空的」。網頁的下拉選單到不了這條路(它送出前自己先擋),
#: 但那是 UI 的第二道防線,不是 API 的契約。
#:
#: ⚠️ 這兩個字串跟 `users.ROLES` 是**同一份東西寫兩次**,而且必須寫兩次 ——
#: `Literal` 只吃字面值,餵不進常數。`schemas` 是葉子模組(只 import `ids`),
#: 反過來 import `users` 會把 `database` 的 engine 一起拖進來,連純 DTO 的測試
#: 都要有 DATABASE_URL 才跑得動,所以不走那條路。**正本是 `users.ROLES`**,
#: 兩邊漂掉由 `tests/test_users_role.py` 的釘樁測試擋下來。
RoleName = Literal["Consultant", "Software engineer", ""]


class HistoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    session_id: str
    question: str
    answer: str
    # 這一題送出時附上的檔案(逗號分隔)。⚠️ 少了這個宣告,Pydantic 會把欄位
    # 從回應裡**濾掉** —— 前端泡泡上那排附件 Token 在答完重抓歷史後就消失。
    uploaded_filename: Optional[str] = None
    output_files: Optional[str]
    sources: Optional[str]  # JSON 陣列字串,前端解析後顯示「參考來源」
    # 整題跑了多久。前端拿它當**最後一步**的結束點,才算得出那一步的耗時
    #(中間幾步是相鄰兩筆的 at_ms 相減)。
    duration_ms: Optional[int] = None
    knowledge_base: Optional[str]
    # running / done。running 代表這題還在跑(可能是別的分頁、甚至別台電腦送出的),
    # 前端看到就顯示回答中並試著接回那條串流。
    status: str
    success: bool
    error: Optional[str]
    # 這一題是誰送出的(帳號名)。共用對話裡不一定是對話的擁有者 ——
    # 對話串要靠它把「自己的發言排右邊、別人的排左邊」分出來。
    # 資料庫裡 asked_by 是 NULL 的紀錄由路由退回用 owner 補。
    asked_by: Optional[str] = None
    # 發問者的顯示名稱,由後端一次查好 —— 前端拿 /api/shareable-users 是查不到
    # 自己的(那份清單排除自己),而被分享的人也未必在名單快取裡。
    asked_by_name: Optional[str] = None
    # Work Flow 通知寫進去的那一題(「這次的結果」)。對話頁不畫它,只畫那則 @ 便條;
    # 紀錄本身要留著:對話清單靠它組出這組對話、追問時它是前情提要(workflow_engine._post_note)
    is_workflow_result: bool = False


class ConversationSummary(BaseModel):
    conversation_id: str
    title: str
    created_at: datetime
    updated_at: datetime
    turn_count: int
    # 這組對話裡還有沒有正在跑的問答。由伺服器判斷,所以重新整理、換一台電腦
    # 都看得到那顆「回答中」的指示。
    running: bool = False
    # 這組對話是別人分享給我的(側邊欄要把它歸到「共用」那一區)。
    # 自己的對話就算分享出去了,對自己而言仍然是 False —— 它還是我的。
    shared_with_me: bool = False
    # 誰分享給我的,顯示在標題旁邊。shared_with_me=False 時是 None。
    shared_by: Optional[str] = None
    # 我把它分享出去了(自己的對話才會是 True),用來在自己的清單上顯示共用圖示
    shared_out: bool = False
    # 這組對話裡 @ 我、而我還沒讀的則數。側邊欄的未讀標記靠它 ——
    # 掛在對話清單上而不是一顆全域數字,使用者才知道**該點哪一組**。
    unread_mentions: int = 0
    # 共用成員的顯示名稱(擁有者排第一)。給側邊欄共用 icon 的 hover 用 ——
    # 想知道「這組現在誰看得到」不該還要點進分享對話框。只有共用中的對話才有值。
    # 由這條清單 API 一起帶,而它本來就被 8 秒輪詢一次,hover 顯示的永遠是近況。
    share_members: List[str] = Field(default_factory=list)


class ShareRequest(BaseModel):
    """一次可以分享給多個人。

    清單長度**與每一筆的內容**都要限制。只限清單長度的話,50 個各 10MB 的字串
    照樣能送進來 —— 那不需要任何漏洞,照著規格送就好。

    每一筆直接套帳號名的字元規則(跟 CreateUserRequest 同一組),不合的在
    pydantic 那層就退掉,不會進到資料庫查詢。
    """

    usernames: List[Annotated[str, Field(pattern=FIELD_PATTERN)]] = Field(
        default_factory=list, max_length=50
    )


class ShareEntry(BaseModel):
    username: str
    display_name: str
    shared_by: Optional[str] = None


class ShareablePerson(BaseModel):
    """可以分享的對象。帳號、顯示名稱,以及一個給畫面用的職稱。

    `role` 是**畫面上的職稱**(@ 選單的副標,資料庫 `users.role`)。
    沒設過或被清掉的人會拿到 `users.DEFAULT_ROLE`,所以這個欄位永遠是非空字串。

    ⚠️ **這條會洩漏權限,而那是「職稱就是權限」的必然結果**:
    `Software engineer` 就是「這個人跑得了 Bash」,而管理員在 `list_active()`
    裡是用 `ADMIN_ROLE`("Admin")補進來的,誰是管理員一目了然。
    這條是**一般帳號也打得到**的清單,所以那兩件事等於對所有登入者公開。
    公司內部工具、職稱本來就要顯示在 @ 選單上,接受這個取捨 ——
    但不要在別的地方寫「這條不洩漏權限」。
    密碼狀態、建立時間那些一律不給:這是一般帳號也打得到的清單。
    """

    username: str
    display_name: str
    role: str
    # 個人設定的頭像(data URI)。None = 沒設過,畫面上顯示名字縮寫。
    # ⚠️ 這一欄會發給所有登入者,所以後端有長度上限(users.MAX_AVATAR_CHARS)。
    avatar: Optional[str] = None


class ConversationSearchHit(BaseModel):
    conversation_id: str
    title: str
    updated_at: datetime
    # 命中的那一段文字前後各留一點,讓人一眼認出是不是自己要找的那則
    snippet: str
    matched_in: str  # question / answer


class RenameConversationRequest(BaseModel):
    title: str = Field(max_length=MAX_TITLE_CHARS)


# ---------------------------------------------------------------- 對話的檔案區
class ConversationFileVersion(BaseModel):
    """檔案區裡的一份檔案。同名的會被收進同一個 group,這是其中一版。"""

    # upload = 使用者附上去的,output = claude 產出或交付的。前端顯示成標籤,
    # 因為「這份是我給它的還是它給我的」跟檔名一樣是辨識的一部分。
    #
    # 用 Literal 而不是 str:這兩個值會被拿去決定讀哪個資料夾(convfiles._base_dir)
    # 與組哪一條下載網址,打錯字的話會靜靜地指到另一個目錄。
    kind: Literal["upload", "output"]
    # 下載網址要用的那一段(檔案是按每一題的 session_id 分資料夾存的;
    # 便條附件則是那則便條的 attachment_sid)
    session_id: str
    # None = 檔案在磁碟上找不到了。跟 missing 一起看。
    size: Optional[int] = None
    created_at: datetime
    # 這個檔案掛在哪一題。**None = 這是便條的附件**,改看 note_id。
    qa_id: Optional[int] = None
    # 這是某則便條的附件時,那則便條的 id。跟 qa_id 恰好一個有值一個 None。
    note_id: Optional[int] = None
    # 這組對話裡的第幾題。點了可以捲到那一則,讓人想起當時的來龍去脈。
    # 便條附件放的是「它前面那一題」的題號 —— 版次是跨題照時間編的,
    # 便條要插進正確的時間位置,不然它帶的新版會被排成舊版。
    turn: int
    question: str
    # 誰送出那一題的(顯示名稱)。共用對話裡這不一定是對話的擁有者。
    asked_by: Optional[str] = None
    # 同名檔案裡的第幾版,1 起算(最舊的是 1)
    version: int
    # 磁碟上已經沒有這個檔案了。**要顯示成「已失效」而不是直接從清單消失** ——
    # 悄悄消失的話,使用者會以為系統把他的檔案吃了,而且無從查起。
    missing: bool = False


# ---------------------------------------------------------------- 側邊欄資料夾
class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    parent_id: Optional[int] = None


class FoldersOut(BaseModel):
    """我的資料夾樹 + 我的歸類。一次拿完 —— 側邊欄要同時畫兩者,分兩趟只會多一次往返。"""

    folders: List[FolderOut] = Field(default_factory=list)
    # conversation_id → folder_id。沒歸類的對話不在裡面。
    items: Dict[str, int] = Field(default_factory=dict)


class CreateFolderRequest(BaseModel):
    name: str = Field(max_length=MAX_TITLE_CHARS)
    parent_id: Optional[int] = None


class UpdateFolderRequest(BaseModel):
    """只帶想改的欄位。parent_id 帶 null 是「搬回頂層」,沒帶就是不動 ——
    兩者要分得出來,路由用 model_fields_set 判斷(pydantic 對 Optional 欄位
    「沒給」跟「給了 null」預設長一樣)。"""

    name: Optional[str] = Field(default=None, max_length=MAX_TITLE_CHARS)
    parent_id: Optional[int] = None


class SetConversationFolderRequest(BaseModel):
    # null = 移出資料夾(回到未歸類)
    folder_id: Optional[int] = None


# ---------------------------------------------------------------- 便條與 @ 提及
# 建立便條**沒有** request schema:那條路由同時收 JSON 與 multipart(帶附件),
# 手動解析(見 routers/notes.py 的說明),長度上限也是在那裡手動檢查的。


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    conversation_id: str
    author: str
    # 作者的顯示名稱。前端不必再自己查一次帳號清單。
    author_name: str
    body: str
    # 這則 @ 到誰(帳號名)。前端用來把那些 token 標起來。
    mentioned: List[str] = Field(default_factory=list)
    # 帳號名 → 顯示名稱。**一定要由後端給**,不能讓前端自己去查帳號清單 ——
    # /api/shareable-users 會把「自己」排除掉(分享給自己沒有意義),所以被 @ 的人
    # 打開時,查不到自己的顯示名稱,畫面上會變成「@jim」而別人看到的是「@吉姆」。
    mentioned_names: Dict[str, str] = Field(default_factory=dict)
    # 這則便條夾帶的檔名。下載網址是 /api/uploads/{attachment_sid}/{檔名}。
    attachments: List[str] = Field(default_factory=list)
    attachment_sid: Optional[str] = None
    # **只在建立當下有值**:哪些檔案沒存成、為什麼(一句人話)。列出來讓前端 toast ——
    # 靜靜略過的話,使用者以為對方收得到那張截圖,而它根本沒存進去。
    rejected_files: List[str] = Field(default_factory=list)


class MentionOut(BaseModel):
    """要通報給我的一則提及。小夥伴的氣泡就是拿這個長出來的。"""

    id: int
    created_at: datetime
    conversation_id: str
    # 誰 @ 我的(顯示名稱)
    author_name: str
    body: str


class MentionPoll(BaseModel):
    """小夥伴輪詢一次拿到的東西。

    `announce` 是「還沒彈過的」,`unread` 是「還沒讀的則數」—— 兩者不一樣:
    氣泡跳完 unread 還是留著,直到他真的打開那組對話。
    """

    announce: List[MentionOut] = Field(default_factory=list)
    unread: int = 0


class UnreadOut(BaseModel):
    """標記已讀的結果。

    marked = 這次真的標掉幾則。前端**只在它大於 0 時**通知側邊欄重抓 ——
    無條件通知的話會跟「側邊欄更新 → 對話頁重抓 → 再標一次已讀」繞成無限迴圈。
    """

    unread: int = 0
    marked: int = 0


class SeenMentionsRequest(BaseModel):
    # 已經通報過的提及 id。一次可以回報多則 —— 輪詢一次可能拿到好幾則。
    ids: List[int] = Field(default_factory=list, max_length=200)


class ConversationFileGroup(BaseModel):
    """同一個檔名的所有版本。

    分組是這個檔案區存在的主要理由:同一組對話裡叫 AI 產出三次「報告.docx」,
    三份會存在三個不同的 session_id 資料夾底下(所以不會互相覆蓋,舊的還在),
    但攤平列出來就是三個一模一樣的檔名 —— 共用的人分不出哪個是最新的,
    很容易下載到舊的那份還不知道。

    所以版次由後端算完,而且 versions[0] 一定是目前版本,舊版排在後面。
    """

    name: str
    versions: List[ConversationFileVersion]


class StatsPrevious(BaseModel):
    """對照期 —— 跟目前區間**同樣長度、緊接在前**的那一段。

    只有 start 與 end 都給了才算得出來(見 `stats._previous_range`),
    所以 `StatsOut.previous` 是 Optional:選「全部」或只填一邊時整個是 None,
    前端就不畫漲跌箭頭。硬湊一個對照期的話,箭頭的意思會隨著資料多寡飄。
    """

    total_questions: int
    avg_duration_ms: float
    # 不含沒有發問者的紀錄,跟 StatsOut.account_count 同一條規則
    account_count: int
    # 這段期間登入成功過的不重複人數(audit_log 的 login_success)
    login_user_count: int = 0
    # 有發問者的題數。「每人平均題數」的分子。
    logged_in_questions: int = 0


class StatsOut(BaseModel):
    total_questions: int
    total_cost_usd: float
    avg_duration_ms: float
    by_period: Dict[str, int]
    # 各帳號的發問次數(key 是帳號名;沒有發問者的紀錄不列)
    by_user: Dict[str, int]
    #: 各帳號的平均耗時(ms)。key 跟 by_user 一模一樣,排行表的第四欄用。
    by_user_avg_duration: Dict[str, float] = Field(default_factory=dict)

    # ── 以下是 dashboard 版面用的,全部有預設值 ──────────────────────
    # 新欄位一律給預設值,舊前端打新後端不會壞、新前端打舊後端拿到的是空的
    # (`previous` 是 None 就不畫箭頭),兩邊可以分開部署。

    #: 有帳號的發問者人數。
    #:
    #: ⚠️ **畫面上不用它**(那張卡顯示的是「登入人數」,走 audit_log)。
    #: 欄位留著是因為它跟 `by_user` 是同一次查詢算出來的,幾乎不花成本,而且
    #: 「有幾個帳號問過問題」跟「有幾個人登入」是兩個不同的問題,前者還是有人會問。
    #: **不要因為它看起來像登入人數就拿它去填那張卡**(見 `login_user_count`)。
    account_count: int = 0

    #: 大圖的兩條線。by_period 是總數,這個是其中有發問者的題目。
    by_period_logged_in: Dict[str, int] = Field(default_factory=dict)

    #: KPI 卡的 sparkline。提問數那張直接用 by_period。
    avg_duration_by_period: Dict[str, float] = Field(default_factory=dict)

    #: 堆疊橫條兩張:專案(knowledge_base,NULL 歸到「(未指定)」)與耗時分布
    by_knowledge_base: Dict[str, int] = Field(default_factory=dict)
    #: 耗時分成三段:fast(< 10 秒)/ medium(10–30 秒)/ slow(> 30 秒)。
    #: **平均耗時看不出這件事** —— 少數跑很久的題目會把平均拉高,而平均本身
    #: 回答不了「有幾題慢到讓人等不下去」。中文字在前端對。
    by_duration_bucket: Dict[str, int] = Field(default_factory=dict)
    #: 題目狀態(running / done)。畫面上不畫,
    #: 欄位留著是因為它幾乎不花成本,而且 `/stats/running` 之外沒有別的地方看得到全站的
    #: 「有幾題卡住」。要拿掉的話連同 `test_status_null_counts_as_done` 一起。
    by_status: Dict[str, int] = Field(default_factory=dict)

    #: 登入成功過的不重複人數(audit_log)。
    #: ⚠️ **跟 `account_count` 不是同一件事**:登入了但沒問問題的人算在這裡、
    #: 不算在那裡。畫面上的「登入人數」用的是這個。
    login_user_count: int = 0
    #: 有發問者的題數(= by_period_logged_in 的總和)。「每人平均題數」的分子 ——
    #: 用 total_questions 當分子的話,沒有發問者的題目會被算到帳號的人頭上。
    logged_in_questions: int = 0
    #: 登入人數的 sparkline
    logins_by_period: Dict[str, int] = Field(default_factory=dict)

    previous: Optional[StatsPrevious] = None


class RunningQuestion(BaseModel):
    """此刻正在跑的一題(管理員的即時一覽)。

    ⚠️ 這份資料**只在記憶體裡**(runs.py),不是查資料庫來的 ——
    服務重啟就全空。它回答的是「現在」,不是歷史。
    """

    run_id: str
    conversation_id: str
    question: str
    #: 這組對話掛在誰名下(同 QARecord.owner)。
    owner: Optional[str] = None
    knowledge_base: Optional[str] = None
    #: 已經跑了多久。**由後端算**,不要讓前端拿開始時間去減自己的時鐘 ——
    #: 使用者的電腦時間跟主機差幾分鐘是常態,而那會讓這個數字變成負的。
    #: (所以這裡**不回**開始時間:回了就會有人拿去減。)
    elapsed_ms: int


class RunningQuestionList(BaseModel):
    items: List[RunningQuestion]


class QuestionUsageItem(BaseModel):
    """題目清單上的一列(管理員的用量明細)。

    ⚠️ **`question` 是全文,不截斷。** 這一頁存在的理由就是「使用者到底問了什麼」——
    截成一行的話,看到一題花了 $8 也還是不知道他在問什麼,而那正是要判斷的事。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    # 這組對話掛在誰名下 / 這一題實際是誰送的(共用對話時兩者會不一樣)
    owner: Optional[str] = None
    asked_by: Optional[str] = None
    conversation_id: Optional[str] = None
    question: str
    knowledge_base: Optional[str] = None
    success: bool = True
    status: str = "done"
    duration_ms: Optional[int] = None
    cost_usd: Optional[float] = None
    #: 使用者刪掉了這組對話。**這一頁仍然列出它**,因為成本與 token 要留得住
    #: (見 models.QARecord.deleted_at)。刪除當下內容就被清空了,所以
    #: `question` 會是空字串 —— 前端要顯示成「已刪除」,不是一題空白的問題。
    deleted_at: Optional[datetime] = None
    #: 這一題的流水帳已經過了保留期被清掉了(`QA_STEPS_RETENTION_DAYS`,預設 90 天)。
    #:
    #: `has_steps=False` 分不出「這題沒查任何檔」、「這題沒有流水帳」與
    #: 「流水帳過了保留期被清掉」;這一欄把第三種標出來 —— 超過保留期的題目
    #: token 欄位也是空的,不分開講的話看起來就像「數字算錯了」。
    steps_expired: bool = False

    # ── 以下由 qa_steps 彙總 ────────────────────────────────
    # 沒有流水帳的紀錄全部是 0 / None —— 前端要能分辨
    # 「沒有明細」跟「明細顯示 0」,所以用 has_steps 明講,不要讓人去猜。
    has_steps: bool = False
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0


class QuestionUsageList(BaseModel):
    items: List[QuestionUsageItem]
    # 符合篩選條件的總筆數(不是這一頁的筆數)—— 分頁要用
    total: int


class StepItem(BaseModel):
    """單題時間軸上的一步。"""

    model_config = ConfigDict(from_attributes=True)

    seq: int
    turn: int
    # turn = 一次模型呼叫 / tool = 一次工具呼叫 / subturn = 子代理裡的模型呼叫
    kind: str
    tool: Optional[str] = None
    target: Optional[str] = None
    #: 沒縮短、沒截斷的標的。可能是 null,前端要退回 target。
    target_full: Optional[str] = None
    detail: Optional[str] = None
    #: 第幾毫秒發生(不是花了多久 —— 見 models.QAStep)
    at_ms: Optional[int] = None
    #: 這一步真正花了多久。只有工具列有,而且沒等到 tool_result 的會是 null。
    duration_ms: Optional[int] = None
    tool_use_id: Optional[str] = None
    model: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    cache_creation_tokens: Optional[int] = None


class RepeatedTarget(BaseModel):
    tool: str
    target: str
    count: int


class QuestionUsageDetail(BaseModel):
    """單題的完整時間軸。"""

    question: QuestionUsageItem
    steps: List[StepItem]
    # 同一個 target 被碰過幾次,多的排前面。**這是去重那份資料看不到的東西**,
    # 也是這整張表存在的主要理由(見 models.QAStep):同一個檔讀了五次,
    # 代表它在原地繞,而畫面上的「參考來源」只會顯示一次。
    repeats: List[RepeatedTarget]


class LoginRequest(BaseModel):
    # 上限給得寬鬆(200)但一定要有:登入是唯一不需要任何憑證就能打的寫入路徑,
    # 沒有上限的話,一個請求就能送幾百 MB 進來讓伺服器拿去做雜湊
    username: str = Field(max_length=MAX_CREDENTIAL_CHARS)
    password: str = Field(max_length=MAX_CREDENTIAL_CHARS)


class LoginChallengeResponse(BaseModel):
    """密碼過了,但這個帳號還要第二道關卡。

    ⚠️ **這裡沒有 token,而且不能有。** 前端拿到的是一張只能用來換 token 的
    中間憑證(見 auth._pending)—— 兩者長得很像,混用的後果是第二道關卡被繞過。
    欄位名字刻意跟 `LoginResponse.token` 不同,就是為了讓混用在前端變成型別錯誤。
    """

    mfa_required: bool = True
    mfa_token: str
    # 顯示用:「以 ming 的身分登入」。密碼已經對了,講出帳號不多洩漏任何東西。
    username: str


class LoginResponse(BaseModel):
    token: str
    username: str
    display_name: str
    # 管理員才看得到那幾個管理頁。一般帳號的登入決定的是「哪些對話是我的」。
    is_admin: bool
    # 登入的當下就把主題送回去,前端才能在導頁前套上。
    # 等 /api/me 那一趟才套的話,共用電腦上(本機記著上一個人的淺色、伺服器是深色)
    # 使用者會看著畫面亮著一整個往返才變暗(index.html 那段行內腳本要避免的
    # 也是這件事)。
    theme: Optional[str] = None


class MeResponse(BaseModel):
    # None = 沒登入。只有 /api/me 會回這個(讓前端知道要顯示登入頁),不是錯誤。
    username: Optional[str]
    display_name: Optional[str]
    is_admin: bool
    # 還在用發下去的預設密碼。那組所有帳號同一個,所以在他改掉之前,
    # 「只有自己看得到」對他其實還不成立 —— 前端要提示他去改。
    password_is_default: bool = False
    # 這個人上次選的主題。None = 沒設過,前端沿用本機的(或預設淺色)。
    theme: Optional[str] = None
    # ── 個人顯示設定。None 一律是「沒設過」,前端用預設值 ──
    avatar: Optional[str] = None
    font_scale: Optional[int] = None
    contrast: Optional[int] = None
    # 常用模型。None = 沒設過,前端用自己的預設(sonnet)。
    preferred_model: Optional[str] = None
    # 右下角的吉祥物。None = 沒設過,前端用 classic。
    companion: Optional[str] = None
    # Bloub 的型態與顏色。None = 沒設過,前端用圓形 + auto。
    companion_shape: Optional[str] = None
    companion_color: Optional[str] = None
    #: 側邊欄要不要顯示「SSH Server」(工程師 / 管理員,而且功能有開)。
    #: 前端**只拿它決定顯不顯示**;真正的擋在 WebSocket 那一端(auth.can_use_terminal)。
    can_terminal: bool = False
    #: 跟 `can_terminal` 同一個答案,寫成前端讀的字串:"full" = 能用,空字串 = 側邊欄沒有 SSH Server。
    ssh_mode: str = ""
    #: Work Flow 開了沒:部署的人放了 workflow_actions.json,而且 SSH 終端機有開(workflows.available)。
    #: 關著的時候側邊欄沒有 Work Flow、/workflow 是 NotFound、/api/workflows 一律 404。
    #: 能不能用另外看 `can_terminal`(工程師 / 管理員)。
    workflow_enabled: bool = False
    #: 個人筆記開了沒(config.NOTEBOOK_ENABLED,預設開):側邊欄 Notes、對話裡存筆記的鈕都看它。關著時 /api/notebook 回 404
    can_notebook: bool = False


class ThemeRequest(BaseModel):
    theme: str = Field(pattern="^(light|dark)$")


class DisplayPrefsRequest(BaseModel):
    """字級、對比與常用模型。只帶想改的,沒帶的不動。

    ⚠️ 範圍在**後端**夾(`users.set_display_prefs`),不是只靠這裡的 ge/le ——
    這兩個值會被寫進 CSS,而字級 0 的畫面連把它調回來的拉桿都看不見。

    ⚠️ `preferred_model` **不在這裡比對白名單**,同一個理由:合法值是
    `config.ALLOWED_MODELS`(環境變數決定的),而 Pydantic 的 pattern 是
    寫死在型別上的。比對在 `users.set_display_prefs`,不合法的當成沒帶 ——
    回 422 對這個欄位沒有意義(它是偏好,不是使用者打的字)。
    `max_length` 只是別讓人往資料庫塞長字串。
    """

    font_scale: Optional[int] = Field(default=None, ge=0, le=400)
    contrast: Optional[int] = Field(default=None, ge=0, le=400)
    preferred_model: Optional[str] = Field(default=None, max_length=64)
    #: 吉祥物。白名單在 `users.COMPANIONS`,不認得的當成沒帶(跟常用模型同一條)。
    companion: Optional[str] = Field(default=None, max_length=16)
    #: Bloub 的型態 / 顏色。白名單在 `users.COMPANION_SHAPES` / `COMPANION_COLORS`,同一條規矩。
    companion_shape: Optional[str] = Field(default=None, max_length=16)
    companion_color: Optional[str] = Field(default=None, max_length=16)


class AvatarRequest(BaseModel):
    """頭像的 data URI。空字串或 null = 拿掉頭像。

    ⚠️ 長度上限在 `users.set_avatar` 擋(`MAX_AVATAR_CHARS`),不在這裡 ——
    Pydantic 的 max_length 會在超過時回 422,而我們要的是一句看得懂的 400。
    """

    avatar: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(max_length=MAX_CREDENTIAL_CHARS)
    new_password: str = Field(max_length=MAX_CREDENTIAL_CHARS)


# ---------------------------------------------------------------- 多因子驗證

#: 驗證碼欄位的長度上限。6 位數的 TOTP 塞得下,而且容得下使用者順手打的空白;
#: 再多就沒有意義 —— 而這個欄位在**未認證**的路徑上,能小就小。
MAX_MFA_CODE_CHARS = 16


class MFAVerifyRequest(BaseModel):
    """登入第二關。`code` 是手機上那組 6 位數(見 mfa.verify_code)。"""

    mfa_token: str = Field(max_length=MAX_CREDENTIAL_CHARS)
    code: str = Field(max_length=MAX_MFA_CODE_CHARS)


class MFAEnrollResponse(BaseModel):
    """管理員發放時回傳的東西,前端拿它畫 QR。

    ⚠️ **這是管理員發放的模型**,所以密鑰會經過管理員的畫面。自助綁定的模型
    連管理員都拿不到它 —— 差別與取捨寫在 `app/mfa.py` 的模組說明。"""

    secret: str
    #: 每 4 個字一組。人要照著螢幕敲進手機,連在一起一定會看丟位置。
    formatted_secret: str
    #: `otpauth://…`,App 掃 QR code 或直接貼上都吃這串。
    otpauth_uri: str


class LockEntry(BaseModel):
    """被鎖定的帳號或 IP。key 是帳號名稱或 IP 位址。"""

    key: str
    # 還剩幾秒自動解開。⚠️ **`-1`(ratelimit.PERMANENT)代表永久封鎖** ——
    # 那一種管理員不處理就是一直鎖著。目前 IP 層預設就是永久,所以這個值
    # 實務上多半是 -1,前端要分開顯示(見 Security 頁)。
    retry_after: int


class LocksOut(BaseModel):
    accounts: List[LockEntry]
    ips: List[LockEntry]


class GeoAllowEntry(BaseModel):
    """登入白名單的一條(`models.GeoAllowIP`)。

    **只有 IP,沒有備註欄。** `created_at` 是資料列的中繼資料,畫面上不顯示。
    """

    #: 正規化過的網段,單一位址也是 `/32`(見 `geo_allow.normalize`)。
    cidr: str
    created_at: datetime


class GeoAllowRequest(BaseModel):
    """新增與刪除共用 —— 兩邊要的都只是「哪一條 IP」。

    刻意不拆成 Add / Remove 兩個逐字相同的類別:同一個欄位寫兩次,而解釋
    「為什麼是 64」的註解只會留在其中一個上面。
    """

    # IPv6 最長 45 字,加上 /128 的前綴,給到 64 綽綽有餘(跟 UnlockRequest 一致)
    ip: str = Field(max_length=64)


class UnlockRequest(BaseModel):
    # 兩個都可以給,但至少要有一個
    username: Optional[str] = Field(default=None, max_length=MAX_CREDENTIAL_CHARS)
    # IPv6 最長 45 字,給到 64 綽綽有餘
    ip: Optional[str] = Field(default=None, max_length=64)


class AuditEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    event: str
    actor: Optional[str]
    ip: Optional[str]
    detail: Optional[str]


class AuditPage(BaseModel):
    """一頁稽核事件 + 全部有幾筆。

    total 是「符合這次篩選的總筆數」,不是這一頁的長度 —— 前端要靠它算出共幾頁。
    少了它就只能做「還有沒有下一頁」的盲翻,跳不到最後一頁。
    """

    items: List[AuditEntry]
    total: int


# ---------------------------------------------------------------- 帳號管理
class UserOut(BaseModel):
    username: str
    display_name: str
    # "full" = 完整工具,null/其他 = 唯讀
    tools: Optional[str] = None
    disabled: bool
    # 畫面上的職稱(@ 選單的副標)。⚠️ 它就是權限,見 users._FULL_ROLES。
    # ⚠️ 這個宣告不能少:`users.list_users()` 一直有回這個欄位,但沒宣告的話
    # Pydantic 會把它濾掉 —— 帳號管理頁就永遠看不到職稱。
    role: Optional[str] = None
    created_at: Optional[datetime] = None
    password_changed_at: Optional[datetime] = None
    # 還在用發下去的預設密碼(尚未改過)
    is_default_password: bool = False
    #: 已經被發過手機驗證碼(QR code)。
    #: `MFA_REQUIRED` 開著時,這一欄是 False 的人**登不進來** ——
    #: 所以帳號管理頁要把它標出來,管理員才知道還有誰沒發。
    mfa_enabled: bool = False


class AdminAccountOut(BaseModel):
    """管理員自己的帳號狀態(只有手機驗證那一項)。

    **為什麼要獨立一支端點。** 管理員不在 `users` 表裡(密碼在 .env),所以
    `/api/users` 那份清單裡**沒有他**,帳號管理頁上也就沒有他那一列 ——
    而他同樣需要一組手機驗證碼(`MFA_REQUIRED` 開著時他自己也會被擋)。
    少了這一支,「全面強制」開不起來:權限最大的那個帳號永遠發不到 QR。

    刻意**只回這兩個欄位**:停用、刪除、改職稱、重設密碼對管理員都不適用
    (他不在那張表裡),回一個完整的 UserOut 只會讓前端誤以為那些動作可用。
    """

    username: str
    mfa_enabled: bool
    #: 全站是不是已經強制手機驗證(`MFA_REQUIRED`)。
    #:
    #: 畫面上要講出來 —— 沒講的話,管理員看到某個帳號「未設定」也不知道那個人
    #: 現在到底進不進得來,而那兩種狀態的處理急迫性完全不同。
    mfa_required: bool


class CreateUserRequest(BaseModel):
    """新增帳號**只收帳號名**。

    職稱一律是 `users.DEFAULT_ROLE`(Consultant)= 唯讀;要給完整權限就建完
    之後改職稱,那一步會寫稽核。`display_name` 留著是給整合/腳本用的,
    網頁不送 —— 沒給就等於帳號名。
    """

    # 帳號名限英數/底線/連字號,長度 1~64 —— 它會進 URL、當主鍵,不能有奇怪字元
    username: str = Field(pattern=FIELD_PATTERN)
    display_name: Optional[str] = Field(default=None, max_length=MAX_TITLE_CHARS)


class UpdateUserRequest(BaseModel):
    # 只帶想改的欄位,沒帶的不動。
    # role 帶空字串 = 清掉(畫面上回到 users.DEFAULT_ROLE),沒帶 = 不動 ——
    # 路由用 model_fields_set 分辨,跟 UpdateFolderRequest 同一個套路。
    # ⚠️ **刻意沒有 `full` 欄位**(職稱就是權限)。權限由 `role` 推導,
    # 留一個能單獨寫 tools 的欄位等於留一條讓兩者不一致的路。要調權限就改職稱。
    disabled: Optional[bool] = None
    role: Optional[RoleName] = None
