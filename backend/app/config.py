import json
import logging
import os
from pathlib import Path
from typing import Optional, TypedDict

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

# claude 子行程的**退路**工作目錄。每個知識庫可以在 knowledge_bases.json 用
# workdir 指定自己的(見 _load_knowledge_bases),沒指定或路徑不存在時才落回這裡。
#
# cwd 決定的不是「讀得到什麼」(那是 --add-dir 的事),而是**「我是誰」**:
# 那個目錄的 CLAUDE.md、`.claude/skills/`、以及 ~/.claude/projects/<目錄代號>/
# 底下的 session 檔。多個專案共用一個 cwd 時,專案 B 的規則會套在專案 A 的問題上,
# 而且所有人的 session 全部混在同一個資料夾裡。
#
# 預設指到 repo 的 `workspace/`(clone 下來就有,裡面只有一份說明檔),讓剛 clone、
# 還沒放專案也還沒設 .env 的人也跑得起來。放了專案之後每一題都用那個專案的資料夾,用不到這裡。
CLAUDE_WORKDIR = os.environ.get("CLAUDE_WORKDIR", str(BASE_DIR.parent / "workspace"))
# 跨模組的比較型問題要翻好幾支大檔,所以給得很寬。
# 逾時也不會整包丟掉 —— 已經寫出來的內容會保留並標記不完整(見 stream_agent)。
CLAUDE_TIMEOUT_SEC = int(os.environ.get("CLAUDE_TIMEOUT_SEC", "3600"))

# 工作目錄以外、要額外掛給 claude 的路徑(逗號分隔,唯讀)。
#
# 留空也可以:claude 不加 --add-dir 也讀得到工作目錄以外的原始碼。這裡的用途是把
# 「允許讀哪些樹」寫成明確設定,而不是依賴主機當下的 .claude/settings.json ——
# 那份設定被改掉時,這邊還撐得住。
#
# symlink 要填解析後的真實路徑:claude 會先 realpath 再判斷權限,填指向端才有效。
#
# ⚠️ 這個變數會掛給**所有**專案,所以上線時應該留空 —— 每個專案讀哪些樹由
# knowledge_bases.json 各筆的 code_roots/knowledge_dirs 決定,填在這裡等於
# 繞過那層專案隔離。
CLAUDE_EXTRA_DIRS = [
    d.strip() for d in os.environ.get("CLAUDE_EXTRA_DIRS", "").split(",") if d.strip()
]

# ---------------------------------------------------------------- 知識庫(專案)
#
# 每一筆是一個專案:它的工作目錄、原始碼樹與文件目錄。每一題只讀選到的那個專案 ——
# 讀錯專案的答案一樣答得很有自信,從答案表面完全看不出來。
KNOWLEDGE_BASES_FILE = Path(
    os.environ.get("KNOWLEDGE_BASES_FILE", str(BASE_DIR / "knowledge_bases.json"))
)

# 專案沒有自己填 suggestions 時,空白頁用這幾題當起點。
# 刻意寫成不綁特定模組的問法,問到哪個專案都不會落空。
DEFAULT_SUGGESTIONS = [
    "這個專案的整體架構是什麼?主要模組各負責什麼?",
    "某個功能的主要流程是從哪裡進入、經過哪些檔案?",
    "這個錯誤訊息是在哪裡丟出來的?可能的原因有哪些?",
]


def _dir_or_warn(
    kb_id: str,
    label: str,
    value: str,
    consequence: str,
    *,
    must_contain: str = "",
) -> str:
    """目錄不合用就當沒填,並留一行 warning 說這個專案因此少了什麼。

    這種降級是**靜默的** —— 服務照跑、答案照出,壞掉的只有隔離或載入,而畫面上
    完全看不出來。所以一定要留 log,不然沒人會發現;`consequence` 寫的就是
    「這個專案會因此少掉什麼」。

    `must_contain` 是「目錄在,但底下少了必要的子目錄」那一關。填錯一層(例如
    skill_dir 直接填到 `.claude/skills`)過得了 `is_dir()`,症狀卻是「路徑看起來
    對,一支都沒載到」—— 跟沒填一樣安靜,所以要用同一條路擋掉、發同一種 log。
    """
    if not value:
        return ""
    path = Path(value)
    if not path.is_dir():
        why = "不存在"
    elif must_contain and not (path / must_contain).is_dir():
        why = f"底下沒有 {must_contain}/"
    else:
        return value
    logger.warning("知識庫 %s 的 %s %s(%s)—— %s", kb_id, label, why, value, consequence)
    return ""


def _kb_path(value: str) -> str:
    """knowledge_bases.json 裡的路徑:絕對路徑原樣用;相對路徑**相對於 backend/**(BASE_DIR)解析,
    不看行程的 cwd —— 服務從哪個目錄起、pytest 從哪裡跑,`../workspace/toptest` 都要指到同一個地方。
    空字串原樣回(「沒填」要留給呼叫端判斷)。"""
    if not value:
        return ""
    path = Path(value)
    # Windows 上 `/home/...` 不算 is_absolute(),但那是主機的絕對路徑,要原樣留著(不存在就照舊只警告)
    if path.is_absolute() or value.startswith(("/", "\\")):
        return value
    return str((BASE_DIR / path).resolve())


def _load_knowledge_bases() -> tuple[list, str]:
    try:
        raw = json.loads(KNOWLEDGE_BASES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [], ""

    bases = []
    for entry in raw.get("bases", []):
        roots = [_kb_path(r) for r in entry.get("code_roots", []) if r]
        # 路徑不存在**只警告,不把整個專案拿掉**。整個 continue 的話,在路徑對不上的
        # 機器上(例如 json 裡全是 Linux 路徑、在 Windows 開發)專案清單會是空的。
        # 所以照樣列出來:code_roots 過濾成真的存在的那幾條(可能是空的 —— 那一題
        # 就只靠 workdir 與文件目錄),降級是靜默的,所以一定要留 log。
        # 完全沒填 code_roots 的是**刻意留白**的骨架,不是設定錯誤,不要跟著洗 log。
        # ⚠️ 該專案照列,但讀不到程式碼:問它的題目只靠 workdir 與文件目錄回答。
        if roots and not Path(roots[0]).is_dir():
            logger.warning(
                "知識庫 %s 的 code_roots 不存在(%s)—— 專案照列,但這台機器上"
                "問它的問題讀不到程式碼",
                entry.get("id"),
                roots[0],
            )
        # 這個專案的工作目錄(claude 子行程的 cwd)。
        #
        # 路徑不存在時**不能**讓整個專案消失 —— 那會讓一個能用的專案因為
        # 「工作目錄還沒建」就從專案清單上不見。
        # 落回共用的 CLAUDE_WORKDIR:答案照樣出得來,只是隔離沒生效。
        workdir = _dir_or_warn(
            entry.get("id"),
            "workdir",
            _kb_path(entry.get("workdir") or ""),
            f"退回共用工作目錄 {CLAUDE_WORKDIR},"
            "這個專案的 CLAUDE.md / skill / session 隔離不會生效",
        )

        # 幾個專案共用的 skill 目錄(選填)。掛法與分組理由見 json 的 _說明。
        # 底下沒有 `.claude/skills/` 就當沒填 —— 載不到東西還掛進 --add-dir,
        # 只是白白讓那個目錄變成可讀的。
        skill_dir = _dir_or_warn(
            entry.get("id"),
            "skill_dir",
            _kb_path(entry.get("skill_dir") or ""),
            "這個專案不會載到那組共用 skill",
            must_contain=".claude/skills",
        )

        bases.append(
            _project(
                entry["id"],
                label=entry.get("label", entry["id"]),
                default_model=entry.get("default_model") or None,
                effort=entry.get("effort") or None,
                workdir=workdir or CLAUDE_WORKDIR,
                code_roots=[r for r in roots if Path(r).is_dir()],
                knowledge_dirs=[d for d in map(_kb_path, entry.get("knowledge_dirs", [])) if d and Path(d).is_dir()],
                skill_dir=skill_dir,
                note=entry.get("note", ""),
                suggestions=entry.get("suggestions", []),
            )
        )

    # 原樣留著,不在這裡換成第一筆:default 可以指 workspace 底下自動找到的資料夾
    # (那些不在這份 json 裡),真正生效的預設由 default_knowledge_base() 決定。
    return bases, raw.get("default", "")


def _project(
    kb_id: str,
    *,
    workdir: str,
    code_roots: list,
    label: str = "",
    default_model: Optional[str] = None,
    effort: Optional[str] = None,
    knowledge_dirs: Optional[list] = None,
    skill_dir: str = "",
    note: str = "",
    suggestions: Optional[list] = None,
) -> dict:
    """一個專案的設定。json 列的與 workspace 自動找到的都從這裡產生,欄位才不會兩邊各寫一份。"""
    return {
        "id": kb_id,
        "label": label or kb_id,
        # 這個專案預設用哪個模型(選填)。原樣存字串,白名單在 /api/config 輸出時才比
        # —— ALLOWED_MODELS 定義在 json 載入之後。用法見 main.get_config。
        "default_model": default_model,
        # 這個專案預設的 effort(選填,low/medium/high/xhigh/max)。agent.stream_agent 用
        # config.safe_effort 過濾,不在白名單就退回全站的 CLAUDE_EFFORT。
        "effort": effort,
        "workdir": workdir,
        "code_roots": code_roots,
        "knowledge_dirs": knowledge_dirs or [],
        # 幾個專案共用的 skill 目錄(選填)。掛法與理由見 json 的 _說明。
        # 跟 code_roots 同一套:不存在就當沒填,但一定要留 log ——
        # 這種降級是靜默的,那個專案會安靜地少掉幾支 skill。
        "skill_dir": skill_dir,
        "note": note,
        # 空白頁上的範例問題。跟著專案走,因為每個專案的內容不一樣 ——
        # 不要引導使用者去問那個專案根本沒有的東西。
        "suggestions": [s for s in (suggestions or []) if s][:4] or DEFAULT_SUGGESTIONS,
    }


KNOWLEDGE_BASES, DEFAULT_KNOWLEDGE_BASE = _load_knowledge_bases()

#: 專案資料夾。底下每一個子資料夾自動當成一個專案(名字就是資料夾名),不必寫進 knowledge_bases.json。
WORKSPACE_DIR = Path(os.environ.get("WORKSPACE_DIR") or BASE_DIR.parent / "workspace")


def _resolved(path: str) -> str:
    try:
        return str(Path(path).resolve())
    except OSError:
        return path


# 上一次掃描的結果。資料夾名單沒變就沿用 —— 「參考來源」縮短路徑時一題會問上很多次,
# 每次只列一次目錄,不必每個資料夾都重新解析路徑。不用目錄的 mtime 當 key:
# Windows 上剛建好資料夾時它不一定馬上更新,新資料夾會漏掉。
_workspace_cache: tuple = (None, [])


def _workspace_projects(listed: list) -> list:
    """WORKSPACE_DIR 底下的子資料夾,每一個是一個專案(程式碼樹、工作目錄都是那個資料夾)。

    資料夾有變動就重掃:放進一個新資料夾,重新整理網頁就看得到,不用重啟服務。
    knowledge_bases.json 已經列了同一個資料夾(workdir 相同或 id 相同)的跳過 ——
    用 json 那一筆,它可以多設範例問題、預設模型。`.` 開頭的資料夾不算;
    兩個捷徑指到同一個資料夾的只算第一個。
    """
    global _workspace_cache
    try:
        folders = sorted(p for p in WORKSPACE_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))
    except OSError:
        return []
    key = (str(WORKSPACE_DIR), tuple(p.name for p in folders), tuple((b["id"], b["workdir"]) for b in listed))
    if _workspace_cache[0] == key:
        return _workspace_cache[1]
    taken_dirs = {_resolved(b["workdir"]) for b in listed}
    taken_ids = {b["id"] for b in listed}
    projects = []
    for folder in folders:
        path = _resolved(str(folder))
        if path in taken_dirs:
            continue
        if folder.name in taken_ids:
            logger.warning(
                "workspace 的資料夾 %s 跟 knowledge_bases.json 某一筆的 id 同名但路徑不同 —— 用 json 那一筆,"
                "這個資料夾不會出現在專案清單上",
                folder,
            )
            continue
        taken_dirs.add(path)
        projects.append(_project(folder.name, workdir=path, code_roots=[path]))
    _workspace_cache = (key, projects)
    return projects


def knowledge_bases() -> list:
    """所有專案:knowledge_bases.json 列的,加上 workspace 底下自動找到的資料夾。"""
    return KNOWLEDGE_BASES + _workspace_projects(KNOWLEDGE_BASES)


def _default_of(bases: list) -> str:
    if any(b["id"] == DEFAULT_KNOWLEDGE_BASE for b in bases):
        return DEFAULT_KNOWLEDGE_BASE
    return bases[0]["id"] if bases else ""


def default_knowledge_base() -> str:
    """新對話用的專案:json 的 default 還在清單裡就用它,不然用清單第一個。"""
    return _default_of(knowledge_bases())


def get_knowledge_base(kb_id):
    """找不到就退回預設值 —— 前端送了舊的 id(例如資料夾改了名)也不該讓整題失敗。"""
    bases = knowledge_bases()
    default = _default_of(bases)
    wanted = kb_id or default
    for base in bases:
        if base["id"] == wanted:
            return base
    for base in bases:
        if base["id"] == default:
            return base
    return None


def all_known_roots() -> list:
    """所有專案的程式碼樹與文件目錄路徑。顯示「參考來源」時用來把長路徑縮短。"""
    roots = []
    for base in knowledge_bases():
        roots.extend(base["code_roots"])
        roots.extend(base["knowledge_dirs"])
    return roots


def resolve_workdir(knowledge_base=None, explicit=None) -> str:
    """這一題的 claude 子行程要在哪個目錄裡跑。**cwd 的唯一推導入口。**

    存在的理由不是省行數,是**一致性**:agent.py 拿它決定子行程的 cwd,
    呼叫端拿它決定要記進 ConversationMeta.workdir 的值。這兩個值只要不一樣,
    那組對話下次續問就會拿 session 去錯的目錄找,而 claude 的回應是
    「查無此 session」—— 使用者看到的是那組對話突然壞掉,而且看不出原因。

    推導只能寫在這一處。各呼叫端自己推的話,漏掉一處的後果正是上面那句:
    子行程用知識庫的 workdir 跑,meta 卻記成 NULL(= 共用工作目錄)。

    explicit 優先,是為了讓「續問」能指定「當初那個目錄」而不是現在選的專案。
    """
    return explicit or (knowledge_base or {}).get("workdir") or CLAUDE_WORKDIR


def all_workdirs() -> list:
    """所有專案的工作目錄(含共用的那一個)。同樣是縮短路徑用的。

    「參考來源」列出工作目錄底下的檔案(例如 CLAUDE.md、規則檔)時,只比對
    CLAUDE_WORKDIR 的話,其他專案的路徑比不到,畫面上就會出現一長串完整絕對路徑。
    """
    dirs = [base["workdir"] for base in knowledge_bases()]
    dirs.append(str(CLAUDE_WORKDIR))
    return list(dict.fromkeys(d for d in dirs if d))

# 同時最多幾個問答在跑 claude 子行程,超過的請求會排隊等前面的讓出名額,
# 避免有人手滑連點或寫迴圈猛打,把主機資源跟 API 費用一次炸開。
#
# 兩道上限一起看(agent._Lane):全站總共 MAX_CONCURRENT_ASKS 題,其中**每個人**最多
# MAX_CONCURRENT_ASKS_PER_USER 題。只有全站那一道的話,一個人連開十題就把
# 所有人的名額吃光;每人那一道擋的就是這個。
# 每人那一道設 0 = 不限。
MAX_CONCURRENT_ASKS = int(os.environ.get("MAX_CONCURRENT_ASKS", "10"))
MAX_CONCURRENT_ASKS_PER_USER = int(os.environ.get("MAX_CONCURRENT_ASKS_PER_USER", "3"))

# 每一步的流水帳(models.QAStep)保留幾天,0 = 永遠不刪。
#
# 為什麼一定要有這個上限:一題少則十幾步、重的一題上百步,而**它不去重**。
# 流水帳的筆數是問答本身的十幾倍到上百倍 —— 不設上限的話,
# 幾個月後統計頁會開始慢,而那時候再回頭補等於要動歷史資料。
#
# 90 天的取捨:查成本問題看的一定是最近的資料(「這個月為什麼變貴」),
# 而題層級的成本(qa_records.cost_usd)本來就永久保留,長期趨勢看那個就夠。
QA_STEPS_RETENTION_DAYS = int(os.environ.get("QA_STEPS_RETENTION_DAYS", "90"))

# ---------------------------------------------------------------- 輸入防護
#
# 使用者送進來的東西最後會交給 claude 子行程:問題本身從 stdin 送(見 agent.feed_stdin),
# model / effort 這類設定是命令列參數。/api/ask 要登入,
# 但那只擋掉「陌生人」,擋不掉「登入後亂送的人」—— 拿到 token 就能繞過前端直接打 API,
# 所以下面這些檢查一條都不能省。

# 問題長度上限。超過就截斷:一題的長度就是送給模型的成本與它要讀的量,
# 一份貼上來的幾 MB log 不該整份變成一題。
MAX_QUESTION_CHARS = int(os.environ.get("MAX_QUESTION_CHARS", "20000"))

# model / effort 會原封不動接到 --model / --effort 後面。不擋的話,
# 送個 "--dangerously-skip-permissions" 進來就等於幫對方多開一個旗標。
#
# ⚠️ 要讓某個模型不能選,要從**白名單**拿掉,不能只從 MODEL_MENU_ORDER 拿掉 ——
# `/api/config` 會把「白名單裡有、排序表沒列到的」接在選單後面。移出白名單後,
# 選單、個人常用、knowledge_bases.json 的 default_model 一起失效;對話裡存著
# 不在白名單的 model 時,`safe_model()` 退回 CLAUDE_MODEL,不會出錯。
# (`usage_limit` 查額度時寫死的 `--model haiku` 不受這份白名單影響 —— 那不是給人選的。)
ALLOWED_MODELS = {"sonnet", "opus"}
# 前端下拉的顯示順序(能力高的在前)。跟白名單分開:
# 白名單管「收不收」,這份管「怎麼排」—— sorted() 的字母序會把順序打亂。
MODEL_MENU_ORDER = ["opus", "sonnet"]
ALLOWED_EFFORTS = {"low", "medium", "high", "xhigh", "max"}


def safe_model(value):
    """只接受白名單內的值;其他(含 None)一律退回設定檔的預設模型。"""
    return value if value in ALLOWED_MODELS else CLAUDE_MODEL


def safe_effort(value):
    return value if value in ALLOWED_EFFORTS else CLAUDE_EFFORT


def _warn_bad_kb_model_settings() -> None:
    """knowledge_bases.json 每個專案的 `default_model` / `effort` 打錯字時留一行 log。

    行為不變(`/api/config` 把不認得的 default_model 當沒填、agent 用 safe_effort 退回
    CLAUDE_EFFORT),但**不能安靜** —— 同一支載入函式裡其他欄位填錯都有 warning,
    這兩個少了的話「這個專案怎麼用的是預設模型」就沒有線索可查。
    放在這裡而不是 _load_knowledge_bases 裡:那支跑的時候白名單還沒定義。
    """
    for base in KNOWLEDGE_BASES:
        model, effort = base.get("default_model"), base.get("effort")
        if model and model not in ALLOWED_MODELS:
            logger.warning("知識庫 %s 的 default_model 不認得(%r),當作沒填(用個人常用/全站預設)", base["id"], model)
        if effort and effort not in ALLOWED_EFFORTS:
            logger.warning("知識庫 %s 的 effort 不認得(%r),退回全站的 CLAUDE_EFFORT", base["id"], effort)


_warn_bad_kb_model_settings()

# 一定要給具體值,不要留空 —— 前端「預設」選項會直接顯示這個值,
# 留空的話使用者會不知道「預設」實際上是叫用哪個模型。
# CLAUDE_MODEL 可填 "sonnet"/"opus" 或完整模型名稱(要填白名單裡的:safe_model() 退回的
# 就是這個值,填白名單外的話,沒選過模型的對話照樣會用它),
# CLAUDE_EFFORT 可填 low/medium/high/xhigh/max(留空才是真的不傳這個參數)。
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "opus")
CLAUDE_EFFORT = os.environ.get("CLAUDE_EFFORT", "")

# ------------------------------------------------- 快取與成本的三道閘門
#
# 一題常常跑幾十步模型呼叫,每一步都扛著整段 context,所以快取命中率直接決定成本。
#
# ⚠️ **前兩個預設是「開」的** —— 也就是說,部署上去、什麼都不改,行為就會變
# (變的是成本,不是答案內容,理由各自寫在下面)。第三個預設關。


def _env_enabled(name: str, default: bool = True) -> bool:
    """讀一個**預設開**的開關:只有明確填了否定字才關掉,留空 = 用預設值。

    ⚠️ **不要拿去讀 TRUST_PROXY_HEADER 那種「預設關」的開關**,那一種用 `_env_opt_in`
    —— 只有明確填了肯定字才開。兩者不能共用同一支:
    預設開的東西誤關頂多少了最佳化;預設關的安全開關誤開就是破洞。
    """
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _env_opt_in(name: str) -> bool:
    """讀一個**預設關**的開關:只有明確填了肯定字才開,留空或打錯字都是關。

    給安全相關、誤開會出事的開關用(MFA_REQUIRED、TRUST_PROXY_HEADER 這類)——
    方向跟 `_env_enabled` 相反,兩者不能互換。
    """
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")


def _env_positive_number_arg(name: str) -> str:
    """讀一個「留空 = 不啟用」的正數,回傳**可以直接接在 CLI 旗標後面的字串**。

    (名字帶 `_arg` 是因為它回的是字串不是數字 —— 這個值不拿來運算,
    只拿來當命令列參數,所以刻意保留使用者原本寫法。)

    ⚠️ **為什麼非驗不可**:這個值會**原封不動**接在旗標後面,而填錯不會在啟動時
    報錯 —— 它會讓**每一題都失敗**,而症狀離 .env 裡那一行非常遠,很難
    聯想到是設定寫錯。

    最容易寫錯的就是 `=0`:它是「關掉」最自然的拼法,而且隔壁的 MAX_UPLOAD_MB
    正好就是用 0 表示不限制。但 0 對這裡的旗標是**非法值**,不是「不啟用」。

    所以壞值一律吞掉 + 留一行 warning,寧可這個功能沒生效,也不要整個服務不能用。
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return ""
    # 只收「純數字,最多一個小數點」。**刻意不只用 float() 判斷** ——
    # float() 吃得下 "inf"、"1e999"、"1_000",三個都 > 0、都會通過,
    # 然後被原樣送給 CLI,而 CLI 不認得 —— 又變成「每一題都失敗」。
    # ⚠️ 用 set 比對而不是 str.isdigit():isdigit() 對**全形數字**("５０")回 True,
    # 而那種值 float() 也吃得下、也 > 0,於是原樣送給 CLI —— 正好是這支要擋的事。
    digits = raw.replace(".", "", 1)
    if digits and all(ch in "0123456789" for ch in digits) and float(raw) > 0:
        return raw
    logger.warning(
        "%s=%r 不是正的十進位數字,已忽略(不會帶這個旗標)。要停用請把值留空,不要填 0。",
        name,
        raw,
    )
    return ""


# 把系統提示裡的「每台機器不一樣」的區段(cwd、env info、memory paths、git status)
# 搬到第一則使用者訊息裡(`--exclude-dynamic-system-prompt-sections`,CLI 預設 false)。
#
# prompt cache 是前綴比對:前綴裡任何一個位元變了,後面全部失效。而那幾個動態區段
# 每一題都不一樣 —— 不開這個旗標的話,快取每次只命中前面一小段就斷掉,後面的
# CLAUDE.md、產品規則、以及**整段對話歷史**,每一題都用 1.25 倍的寫入價從頭重買一次
# (讀取價是 0.1 倍,差 12.5 倍)。症狀是 qa_steps 裡每一題第一輪的 cache_read 是個
# 固定的小常數,cache_write 則等於那組對話當下的長度。
#
# 開這個旗標**不會讓模型少看到任何東西** —— 那幾段資訊照樣送進去,只是換個位置,
# 好讓前面的系統提示保持逐位元穩定。所以預設開。
#
# 安全面(結論是可以開):
# 那幾段從系統提示搬到第一則使用者訊息,資料量與內容**完全一樣**,只是位置換了。
# 裡面是 cwd、平台/日期、memory 路徑、workdir 的 git status —— 沒有機密,
# 而且環境變數的**值**根本進不去(`agent._child_env()` 在子行程啟動前就把
# SECRET_ENV_KEYS 剝掉了)。唯一的差別是:放在使用者訊息裡,被提示注入誘導著
# 覆述出來的機率比放在系統提示裡略高一點。而那些內容本來就已經寫在提示裡
# (`build_context_note` 就在給絕對路徑),所以多出來的暴露面接近零。
#
# ⚠️ 兩個前提,壞了就等於白開(而且**畫面上看不出來**):
#   1. 只在「預設系統提示」下生效 —— 一旦帶了 `--system-prompt` 就會被忽略。
#      agent.py 目前沒有帶,要加的話記得這條會失效。
#   2. 效果要用 qa_steps 驗:第一輪的 cache_read 應該明顯大於關閉時的那個常數。
#      沒變就是沒生效,不要假設它有在作用。
CLAUDE_STATIC_SYSTEM_PROMPT = _env_enabled("CLAUDE_STATIC_SYSTEM_PROMPT")

# 不要載入主機上設定的任何 MCP server(`--strict-mcp-config` 而不給 `--mcp-config`)。
#
# 服務帳號在主機上設定的 MCP server,**工具定義會被載進每一題的提示裡**。但那些工具的
# 名稱(`mcp__<server>__*`)既不在 ALLOWED_TOOLS 也不在 ALLOWED_TOOLS_FULL ——
# **任何帳號都不可能呼叫它們**,每一題都在為一組用不到的工具定義付錢。
#
# 所以預設關掉。這在功能上是 no-op:拿掉的是本來就被白名單擋死的東西,
# 不影響任何一題答得出來或答不出來。
#
# 要放行的話設成 "0"/"false" —— 但先想清楚:要讓網頁真的用得到 MCP 工具,
# 光開這個沒有用,還得把工具名稱加進白名單,那是另一個決定(而且要另外評估風險:
# MCP 工具**不吃 --add-dir 的路徑限制**,跟 Bash 是同一類問題)。
CLAUDE_STRICT_MCP = _env_enabled("CLAUDE_STRICT_MCP")

# claude CLI 的內建工具。終端機 AI 面板(terminal_ai)靠它「一支都不給」。
# **列出名字而不是給空的白名單**:CLI 的預設工具集會隨版本與主機而變
# (有些環境還有 Artifact / Workflow / Skill 那一整排),明著寫死才不會哪天
# 升級之後悄悄多出一支。有多的沒關係,列到的一定關掉。
BUILTIN_TOOL_NAMES = (
    "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite",
    "Task", "TaskOutput", "TaskStop", "Skill", "Workflow", "Monitor",
    "Artifact", "SendMessage", "ListAgents", "ToolSearch", "ScheduleWakeup",
    "CronCreate", "CronDelete", "CronList", "PushNotification", "DesignSync",
    "EnterWorktree", "ExitWorktree", "ReportFindings",
)

# ⚠️ **這裡刻意沒有 CLAUDE_AUTOCOMPACT**(`claude --autocompact`):
#
#   1. 它是**有損**的 —— 壓縮會把舊的工具結果摘要化。結論留得住,但「某支程式
#      第 214 行寫什麼」這種逐字細節會不見。而這裡的答案品質標準正好是
#      `檔案:行號`(見各專案的 CLAUDE.md),失真了**從答案表面看不出來**。
#   2. 它治的是下游。一題跑太多步要靠工作目錄裡的規則把模型導到對的檔案,
#      不是靠把翻過的東西摘掉。

# 單題的成本上限(美金),直接接到 --max-budget-usd 後面。留空 = 不設限。
#
# ⚠️ **這是停損,不是省錢工具。** CLI 沒有 --max-turns,這是唯一擋得住
# 「一題跑上百步、讀掉幾千萬 token」的煞車。它不會讓正常的題目變便宜,
# 只會在失控時把題目切斷 —— 而切斷的代價是答案不完整。
#
# 所以**不要拿它來壓平均成本**,要設在「正常題目碰不到、只有失控才會撞上」的位置。
# 調整前先看實際分佈(qa_records.cost_usd),把值設在中位數的 3~4 倍。
# 換模型或改 effort 之後分佈會整個平移,這個值要跟著重設。
CLAUDE_MAX_BUDGET_USD = _env_positive_number_arg("CLAUDE_MAX_BUDGET_USD")

# ------------------------------------------------------- 工具白名單(分兩級)
#
# 同一套服務,不同帳號給不同的工具。風險跟著人走,而不是全站一起放寬或一起收緊:
#
#   一般帳號 → ALLOWED_TOOLS。唯讀,活動範圍是「工作目錄底下」
#                              加上「--add-dir 掛進來的那幾條」。
#
# ⚠️ 這**不等於**「只能在這一題選到的程式碼樹裡」。工作目錄底下的東西不需要
#    --add-dir 就讀得到,工作目錄底下若還放了別的專案的東西,一樣讀得到。所以同一個工作目錄裡的分野
#    只剩規則(各專案 CLAUDE.md 的路徑表),不是機制 —— 要當成機制的話,
#    得先把不屬於該專案的東西從那個目錄移出去。
#   進階帳號(資料庫 users.tools = "full",以及管理員)→ ALLOWED_TOOLS_FULL。
#
# 每次呼叫都會再疊一條只限當次 outputs/{session_id} 資料夾的 Write 規則(見 agent.py)。
#
# ⚠️ **`Bash(...)` 只該出現在 FULL 那組。** 兩個理由:
#
#   1. `Bash(find:*)` 比對的是「開頭是不是 find」,而 `find . -exec <任何指令> \;`
#      開頭正是 find —— 等於放行任意指令。想限制成「只能 find」是做不到的。
#   2. Bash **不吃 `--add-dir`**(那個參數只約束 Read 工具),所以 `cat` 讀得到
#      服務身分讀得到的任何檔案:~/.claude 憑證、.env(含資料庫密碼)、~/.ssh。
#
# 也就是說:給了 Bash 就等於給了那個帳號「以服務身分在主機上為所欲為」的能力。
# 這是刻意的選擇(進階帳號本來就要能跑東西),但一定要清楚它的份量。
ALLOWED_TOOLS = os.environ.get("CLAUDE_ALLOWED_TOOLS", "Read,Grep,Glob")

# 進階帳號用的。列舉而不是留空 —— headless(-p)模式下沒有人能批准不在名單上的工具,
# 留空等於什麼都不能用,而不是「全部放行」。
ALLOWED_TOOLS_FULL = os.environ.get(
    "CLAUDE_ALLOWED_TOOLS_FULL",
    "Read,Grep,Glob,Bash,Write,Edit,WebFetch,WebSearch,TodoWrite,Task",
)

# ------------------------------------------------- full 帳號額外能寫的目錄
#
# 只掛給 full 帳號的 --add-dir(逗號分隔的絕對路徑)。用途:讓進階帳號能把整理好的
# 流程知識累積回 skill 的 flows/ 目錄。
#
# ⚠️ **只掛到 flows/ 這一層,不要掛整個 skill 目錄。**
#   掛 `.../<skill>/flows`      → 只能寫「流程筆記」(知識,可累積)。
#   掛 `.../<skill>`(上一層)   → 連 SKILL.md 都能寫了 = 能改 claude 的
#                                 做事方法、影響所有人,那是刻意不給的。
#
# flows 是知識、SKILL.md 是指令,界線就切在這個目錄邊界上。
# 唯讀帳號不掛(見 auth.writable_dirs_for),而且他們也沒有全域 Write 工具。
CLAUDE_FULL_EXTRA_DIRS = [
    d.strip() for d in os.environ.get("CLAUDE_FULL_EXTRA_DIRS", "").split(",") if d.strip()
]

# 唯讀帳號的讀取範圍往回涵蓋同一組對話的前幾題(見 agent.scope_readonly_tools)。
#
# 附件是**每一題**一個資料夾(session_id 每題一個),所以續問要讀得到第 1 題附的
# 那份 PDF,就得把前幾題的題號一起放行。這個數字是「往回幾題」。
#
# 為什麼要有上限:每一題會多出 2 個目錄 × 3 支工具 = 6 條規則,而規則全部接在
# argv 上。沒有上限的話,一組問了兩百題的對話會把指令列撐到很難看。
# 30 題的取捨:超過的是最早那幾題的附件,而那時候它們早就不在對話上下文裡了。
PRIOR_SESSION_DIRS_LIMIT = int(os.environ.get("PRIOR_SESSION_DIRS_LIMIT", "30"))
# ⚠️ **絕對不要把 `Edit` 放進來。**
#
# Claude Code 的 `Edit` 規則是「所有會改檔案的工具」的統稱,`Write` 也算在裡面;
# 而拒絕清單的優先權高於允許清單。所以只要這裡有 `Edit`,agent.py 放行 outputs 的那條
# `Write(<outputs 的絕對路徑>/**)` 就完全沒有作用 —— claude 會回報
# 「寫檔權限還沒放行,請在提示視窗按允許」,但 headless 模式根本沒有提示視窗,
# 使用者怎麼弄都不會過(去 /permissions 加規則也沒用,那是另一套)。
#
# 拿掉 Edit 不會讓它變得可以亂改檔案:`--allowedTools` 本身就是白名單,
# 不在名單上的工具在 -p 模式下沒有人能批准,等於還是被擋。
DISALLOWED_TOOLS = os.environ.get("CLAUDE_DISALLOWED_TOOLS", "NotebookEdit")

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'app.db'}")

# 上傳/產生檔案都放在這底下,不會碰到任何一棵程式碼樹。
#
# ⚠️ **這個位置刻意「不跟著專案走」**,即使 cwd 跟著專案走。理由:
#
#   取檔的那幾支(routers/files.py 的 /api/files、/api/uploads、/api/preview,
#   與檔案區 convfiles.py)只靠 session_id 找檔案,沒有專案這個維度。
#   依專案分家的話,每一支都要先反查「這個 session 是哪個專案」才找得到檔案。
# ⚠️ **它也絕對不能落在任何一個專案的 workdir 底下。**
#
#   cwd 底下的東西不需要 --add-dir 就讀得到。agent-knowledge 一旦落在某個專案的
#   工作目錄裡,那個專案就能翻**所有人**的上傳與產出 —— 下載端點要登入擋得住外人
#   (見 routers/files.py),但擋不住模型自己去讀,那是另一道牆。
#
#   ⚠️ **所以它不能設在任何一個 workdir 底下。** 最容易踩的是
#   `CLAUDE_WORKDIR/agent-knowledge` —— CLAUDE_WORKDIR 本身就是某個專案的
#   workdir,那樣就正好落進上面那個情境。下面有一段開機檢查,踩到會在 log 叫出來。
#   所以預設放在 backend/data/agent-knowledge(跟 app.db 同一層,不是任何專案的 cwd)。
#
# 代價:專案的 cwd 都構不到它,所以 claude 讀上傳檔、寫產出檔一律走
# 絕對路徑(Read 不受 --add-dir 限制;Write 靠 allowedTools 的路徑規則放行,
# 不掛 --add-dir —— 理由見 agent.stream_agent)。
AGENT_KNOWLEDGE_DIR = Path(
    os.environ.get("AGENT_KNOWLEDGE_DIR", str(DATA_DIR / "agent-knowledge"))
)
UPLOAD_DIR = AGENT_KNOWLEDGE_DIR / "uploads"
OUTPUT_DIR = AGENT_KNOWLEDGE_DIR / "outputs"


def _warn_if_agent_knowledge_inside_a_workdir() -> None:
    """agent-knowledge 落在某個專案的 cwd 底下就叫一聲。

    這是靜默失效:服務照跑、檔案照存照下載,唯一的差別是那個專案讀得到別人的
    檔案,而畫面上永遠看不出來。所以只能靠開機時的這一行 log。

    專案清單用 `knowledge_bases()`:knowledge_bases.json 列的,加上開機當下 workspace
    底下的資料夾。開機之後才在 workspace 新增的資料夾,要等下次重啟才會被檢查到。
    """
    try:
        here = AGENT_KNOWLEDGE_DIR.resolve()
    except OSError:
        return
    for base in knowledge_bases():
        try:
            wd = Path(base["workdir"]).resolve()
        except OSError:
            continue
        if here == wd or wd in here.parents:
            logger.warning(
                "AGENT_KNOWLEDGE_DIR(%s)落在專案 %s 的工作目錄(%s)底下 —— "
                "那個專案不需要 --add-dir 就讀得到所有人的上傳與產出檔。"
                "請用 AGENT_KNOWLEDGE_DIR 把它移到所有 workdir 之外。",
                here,
                base["id"],
                wd,
            )


_warn_if_agent_knowledge_inside_a_workdir()
# 單檔上傳上限(MB)。0 或負數 = 不限制。
#
# 圖片在瀏覽器端已經先縮到長邊 1568px 才上傳(見 frontend/src/lib/image.ts),
# 一張 4K 截圖縮完只有幾百 KB,所以 50MB 對日常用途是綽綽有餘的 ——
# 這個數字擋的是「一個帳號把硬碟塞滿」。
#
# ⚠️ **預設值是 50,不是「不限制」。** 硬碟滿了是整台機器一起出事 ——
# 資料庫通常跟原始碼樹在同一顆上。真的要放開就明寫 MAX_UPLOAD_MB=0,不要靠預設值。
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "50"))

# 一個請求最多帶幾個檔、加起來最多幾 MB。上面那條是**單檔**上限,而 multipart
# 一個請求可以塞上千個檔 —— 沒有這兩條,單檔 50 MB 的限制等於沒有。
MAX_UPLOAD_FILES = int(os.environ.get("MAX_UPLOAD_FILES", "20"))
# 預設是單檔上限的兩倍;MAX_UPLOAD_MB=0(不限制單檔)時這裡也跟著 0 = 不限制,
# 「放開」要放整條,不要單檔放開了請求還被另一個數字擋住而畫面上看不出來。
MAX_REQUEST_MB = int(
    os.environ.get("MAX_REQUEST_MB") or str(MAX_UPLOAD_MB * 2 if MAX_UPLOAD_MB > 0 else 0)  # .env.example 留空 = 預設
)

# 個人筆記的圖片。放在 data/ 底下跟 app.db 一起:部署是覆蓋程式目錄,
# 不會動到 data/;備份 data/ 的時候也會一起帶走。
#
# ⚠️ 不放 AGENT_KNOWLEDGE_DIR:那裡是 claude 讀得到的地方(上傳、產出檔),
# 而筆記永遠不會送給 claude。
NOTEBOOK_DIR = Path(os.environ.get("NOTEBOOK_DIR", str(DATA_DIR / "notebook")))
# 整個個人筆記功能的開關。**預設開**。關著的時候側邊欄沒有 Notes、對話裡沒有存筆記的鈕(前端看 /api/me 的 can_notebook),
# `/api/notebook`(含多人同時編輯那條 WebSocket)全部當作不存在。
# 要關:.env 加 `NOTEBOOK_ENABLED=0` 再重啟,不用重新打包。資料表照樣建、data/notebook 不會被刪。
# 用 _env_enabled 讀(只認否定字為關):這不是安全開關,填錯頂多是功能多開了,不會開出破洞。
NOTEBOOK_ENABLED = _env_enabled("NOTEBOOK_ENABLED", default=True)
# 上限:擋的是一個帳號把硬碟塞滿,不是一般使用
NOTEBOOK_MAX_BODY_BYTES = 200 * 1024
# 編輯器格式(doc,JSON)的上限:同一份內容 JSON 比 Markdown 大好幾倍(每個字的格式都寫出來),給 1 MB
NOTEBOOK_MAX_DOC_BYTES = 1024 * 1024
# 垃圾桶留幾天
NOTEBOOK_TRASH_DAYS = 30
NOTEBOOK_MAX_IMAGE_BYTES = 5 * 1024 * 1024
NOTEBOOK_MAX_NOTES = 1000
NOTEBOOK_MAX_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024

# **沒帶任何憑證**的請求本文上限(KB)。匿名的合法請求只有 /api/login 那種幾百 bytes
# 的 JSON;而 FastAPI 是先讀完 body 才驗 token,沒有這條的話匿名者送幾 GB 就能把
# /tmp 塞滿,授權那步永遠跑不到(security.BodySizeLimit)。
ANON_MAX_REQUEST_KB = int(os.environ.get("ANON_MAX_REQUEST_KB", "64"))

# 上傳目錄所在的硬碟剩不到這麼多 MB 時拒收上傳。這是「一個帳號把硬碟塞滿」
# 最後的閘:單檔與單請求的上限擋不住一個人迴圈送一萬次。
MIN_FREE_DISK_MB = int(os.environ.get("MIN_FREE_DISK_MB", "2048"))

# 管理員帳密。可以進用量統計、安全、帳號管理三頁,一般使用者不行。
#
# 預設 tiptop / tiptop:沒有 .env 也照常開機、登得進去,剛 clone 下來就能看畫面。
# 開機只擋兩種值(見 admin_password_is_usable 與 main.init_database):空字串,以及
# 範本裡的佔位字串(ADMIN_PASSWORD_PLACEHOLDERS)。預設值 "tiptop" 刻意不在那份名單裡。
# ⚠️ **上線前一定要在 .env 改掉。** 管理員帳密等於寫在版控裡的字串時,任何讀得到 repo 的人
# 都進得來。嚴重的不是「能看報表」:auth.allowed_tools_for 給管理員 ALLOWED_TOOLS_FULL,
# 裡面有 Bash,而 Bash **不吃 --add-dir 的限制**(見上面那段)。
# 猜中預設值 = 以服務帳號的身分在主機上任意執行指令。
# 而且 routers/auth.py 的改密碼端點明確拒絕管理員,站內沒有任何補救辦法。
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "tiptop")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "tiptop")
AUTH_TOKEN_TTL_SEC = int(os.environ.get("AUTH_TOKEN_TTL_SEC", str(12 * 3600)))

# 閒置多久之後 token 自動失效(秒)。0 = 不做閒置逾時。
#
# **這是「關掉瀏覽器就要重新登入」的伺服器端後盾。** 前端那一半(token 存
# sessionStorage、cookie 是 session cookie)全都在瀏覽器那一側 —— 而瀏覽器的
# 「回復上次工作階段」(Ctrl+Shift+T,或設定成開機還原分頁)會把兩者一起帶回來,
# 於是那張 token 又活了,伺服器本來完全不知情。
#
# 關著的瀏覽器不會送請求,計時器就不會被推後 —— 所以這個值就是「關掉之後最多
# 還能被救回來多久」。
#
# ⚠️ 不要設得太短。網頁本身每 8 秒就在輪詢(對話清單、@ 提及),所以只要分頁
# 開著就一直算「在使用」,**60 分鐘不會把正在讀答案的人踢掉**。真正會被這個值
# 咬到的是「關了分頁但沒關瀏覽器,一小時後又開回來」—— 那本來就該重新登入。
AUTH_IDLE_TIMEOUT_SEC = int(os.environ.get("AUTH_IDLE_TIMEOUT_SEC", str(60 * 60)))

# ---------------------------------------------------------------- 多因子驗證
#
# 驗證器 App 裡顯示的名字。使用者手機上可能同時有十幾個項目,這個字串是他分辨
# 「哪一個是這個系統」的唯一線索。
#
# 值就是前端那個完整品牌字串 `AskME 問我問我!`(App 的窄欄位可能會截斷)。
#
# ⚠️ **含空白、中文與 `!`,兩個讀取端都要撐得住:**
#   `otpauth://` 那一側 —— `totp.provisioning_uri` 會 percent-encode(UTF-8),
#     Google Authenticator 認得;不要自己去掉那層編碼。
#   `.env` 那一側 —— 範本裡**要加引號**:含空白的值交給不同的讀取端
#     (python-dotenv、docker、shell 的 source)時,沒引號的寫法不保證讀出同一個值。
#
# ⚠️ **綁定之後不要改**:它被寫進 `otpauth://` 的標籤,而 App 是在掃描的當下
# 把名字記下來的 —— 改了只會讓「之後新綁的人」跟「已經綁好的人」在同一支手機上
# 顯示成兩個不同的名字,已經綁好的那些**不會跟著更新**。真的要改就得請每個人
# 刪掉舊項目、由管理員重新產生一次 QR 再掃。
MFA_ISSUER = os.environ.get("MFA_ISSUER", "AskME 問我問我!")

# 密碼過了、還沒輸入驗證碼之前,那張中間憑證的壽命(秒)。
#
# 給 5 分鐘:夠他拿出手機、解鎖、找到那個項目、必要時等下一組碼跳出來,
# 但短到「登入到一半走開去開會」回來時已經要重打密碼。
#
# ⚠️ 這張憑證**只能用來換 token,不能拿來打任何其他 API**
# (見 auth.py 的 `_pending` —— 它跟 `_tokens` 是兩張完全分開的表)。
# 兩者混在一張表裡的話,只過了第一關的人就等於已經登入了,MFA 形同虛設。
MFA_CHALLENGE_TTL_SEC = int(os.environ.get("MFA_CHALLENGE_TTL_SEC", "300"))

# **每個人都一定要有多因子驗證才登得進來。**
#
# 開著的時候,還沒被管理員發過 QR code 的帳號**一律登不進來**(密碼對也一樣),
# 錯誤訊息會叫他去找管理員。關著的時候,只有已經綁定的人需要輸入六碼,
# 沒綁的人照舊只用密碼。
#
# ⚠️ **預設關閉,而且要等全部人都綁好才准開。** 先開再發 QR 的話,
# 那一瞬間所有人都登不進來 —— 包含管理員自己(他也是一個帳號)。
# 正確順序:帳號管理頁把每個人的 QR 發完、確認大家都掃過並登入過一次,
# 最後才把這個設成 1 並重啟服務。
#
# ⚠️ 管理員自己也要先綁。他被這條擋住的話沒有任何網頁上的救法,
# 只能上主機刪 user_mfa 那一列(指令見 docs/security.md〈有人被鎖在門外的時候〉)。
# 預設關、只有明確填了肯定字才開(`_env_opt_in`):誤開的後果是所有人(含管理員)
# 在部署的那一瞬間全部登不進來。
MFA_REQUIRED = _env_opt_in("MFA_REQUIRED")

# **從信任的網路登入就不必輸入六碼。**
#
# 信任的來源**直接沿用 `LOGIN_IP_ALLOWLIST`**,不另外開一個變數:那會變成兩份要
# 同步維護的 IP 清單,而漏掉一邊的症狀是「有時候要六碼、有時候不用」,很難查。
#
# 開著的時候,來源落在白名單裡的登入**整個跳過第二關**:綁了 MFA 的人不必輸入
# 六碼,`MFA_REQUIRED` 也不擋沒綁的人。適用**所有帳號,包含管理員**。
# 每一次跳過都會在稽核紀錄留下 `login_mfa_skipped_ip`,事後查得到是誰、從哪個 IP。
#
# ⚠️ **這是拿安全換方便,而且換掉的正好是 MFA 唯一在擋的那件事 ——「密碼已經外洩」。**
# 開了之後,任何連得上那個網路的人(訪客 Wi-Fi、被入侵的內網電腦、借出去的筆電)
# 只要有密碼就能登入,第二關不會再問。
#
# ⚠️ **前提跟白名單本來的用途一樣:`client_ip()` 要拿得到真 IP。**
# `FORWARDED_ALLOW_IPS` 設錯的時候,後端看到的每個請求都來自 nginx 自己的位址 ——
# 那個位址不在白名單裡,所以症狀是「從信任的網路登入還是要輸入六碼」。方向是安全的那一邊,
# 但**千萬不要為了「修好它」把那個位址填進 `LOGIN_IP_ALLOWLIST`**:那等於
# 全世界都免第二關,而且同時把 IP 層的封鎖一起關掉。要修的是代理設定。
#
# 預設關(`_env_opt_in`):這一條誤開的後果是一道安全關卡靜靜地消失(沒有任何錯誤訊息)。
MFA_SKIP_ON_TRUSTED_IP = _env_opt_in("MFA_SKIP_ON_TRUSTED_IP")

# ADMIN_PASSWORD 的已知佔位字串,一律當成「還沒設」,開機時擋下(見 main.init_database)。
#
# 名單是兩句中文佔位句(「請改成你自己的密碼」「請改成測試用的密碼」)與 changeme、password。
# 只看「是不是空的」不夠:這幾個字串非空,只檢查「有沒有設」會直接放行,而它們誰都猜得到。
#
# ⚠️ 預設值 `tiptop` **刻意不在**名單裡:沒有 .env 時要能直接開機,範本(backend/.env.example、
# deploy/docker/askme.env.example)也是寫 tiptop。對外上線的站要靠在設定檔改掉它,不靠這份清單。
ADMIN_PASSWORD_PLACEHOLDERS = frozenset(
    {
        "請改成你自己的密碼",
        "請改成測試用的密碼",
        "changeme",
        "password",
    }
)


def admin_password_is_usable() -> bool:
    """ADMIN_PASSWORD 有沒有被真的設過(不是空的、也不是佔位字串)。"""
    return bool(ADMIN_PASSWORD) and ADMIN_PASSWORD not in ADMIN_PASSWORD_PLACEHOLDERS

# .env 裡那些**不可以流進 agent 子行程**的設定。
#
# agent.stream_agent 呼叫 create_subprocess_exec 時若不傳 env=,子行程會
# 繼承整個 os.environ —— 而這個模組頂端的 load_dotenv() 已經把 backend/.env
# 灌進去了。結果是任何一個拿得到 Bash 的帳號(role = "Software engineer")
# 只要叫 agent 跑一次 `env`,這些值就會被串流到瀏覽器,並寫進 qa_records.answer
# 永久留著。透過提示注入的話,連使用者本人都不需要有這個意圖。
#
# ⚠️ **之後新增機密設定時要一起加進這份清單。**
# 這裡刻意用黑名單而不是白名單:claude CLI 需要一個正常的環境(HOME 找憑證、
# PATH 找工具、還有各平台自己一堆變數),白名單漏掉一個的症狀是
# 「agent 在主機上莫名其妙跑不起來」,而那比多洩漏一個變數更難查。
SECRET_ENV_KEYS = (
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    # SSH 終端機的登入憑證。子行程(問答、AI 助手)都不該看得到 —— AI 助手那一支的輸入
    # 正是不可信的主機畫面,這是縱深防禦的第二層。
    "SSH_TERMINAL_PASSWORD",
    "DEFAULT_USER_PASSWORD",
    "DATABASE_URL",
)
# ⚠️ 上面只是寫得死的那幾個。terminal_hosts.json 每一台的 `password_env`(主機密碼放在哪個變數)
# 是設定檔決定的名字,讀完設定檔之後才補進來 —— 見 `_TERMINAL_HOSTS_FILE_ENTRIES` 底下。

# ------------------------------------------------------------ 登入嘗試次數限制
#
# 兩層都開:帳號層 5 次鎖 15 分鐘,IP 層 10 次永久封鎖。
#
#   帳號層 —— **預設 5 次鎖 15 分鐘**。
#
#             ⚠️ **這一層可以被拿來當武器** —— 知道「alice」這個帳號存在的人,
#             故意打錯五次就能把他鎖住 15 分鐘,而且可以一直重複。
#             它也擋不了認真的攻擊(15 分鐘就自動解),真正擋密碼猜測的是 IP 層。
#             帳號被惡意鎖住的話,管理員可以在 /security 那一頁當場解開。
#             要關回去就把 LOGIN_MAX_ATTEMPTS 設成 0。
#
#   IP 層 —— 10 次就**永久封鎖,只有管理員能在 /security 解開**。
#            同一個來源累積失敗 10 次,那不是打錯字,是有人在掃;放它自動解開
#            等於讓對方等一下再回來繼續掃。
#
# 門檻設 0 或負數 = 停用該層。LOGIN_IP_LOCKOUT_SEC 設 0 = 永久鎖(預設)。
LOGIN_MAX_ATTEMPTS = int(os.environ.get("LOGIN_MAX_ATTEMPTS", "5"))
LOGIN_LOCKOUT_SEC = int(os.environ.get("LOGIN_LOCKOUT_SEC", "900"))
LOGIN_IP_MAX_ATTEMPTS = int(os.environ.get("LOGIN_IP_MAX_ATTEMPTS", "10"))
LOGIN_IP_LOCKOUT_SEC = int(os.environ.get("LOGIN_IP_LOCKOUT_SEC", "0"))

#: 永遠不會被 IP 層鎖住的來源(例如辦公室的對外 IP),逗號分隔,單一位址或 CIDR 網段。
#: 例:`LOGIN_IP_ALLOWLIST=203.0.113.5,203.0.113.0/24,2001:db8::/32`
#:
#: ⚠️ **這份名單管兩件事**,加一個 IP 進來之前要知道兩件都會發生:
#:   1. 免 IP 層的永久封鎖(本來就有的)。
#:   2. `MFA_SKIP_ON_TRUSTED_IP=1` 時,從這裡來的登入**不必過第二關**。
#: 地理封鎖仍然**不看**這一份 —— 那一關的例外是資料庫裡的 `geo_allow_ips`
#: (安全頁可以隨時增刪,不必重啟),兩份名單刻意分開,理由見 `app/geo_allow.py`。
#:
#: **它只免 IP 那一層,帳號層照舊。** 也就是說從這些來源連打錯 5 次還是會鎖住那個
#: 帳號 15 分鐘 —— 密碼猜測的保護還在,拿掉的只有「同一個出口的所有人共用一個計數器,
#: 十次就一起被永久封鎖」這個風險。IP 層跨重啟保留(見 models.LoginIPBlock),
#: 少了這份名單的話,同一個出口的所有人被鎖死之後連重啟都救不回來。
#:
#: ⚠️ **這份名單的前提是 `client_ip()` 拿得到真 IP。** 服務在 nginx 後面時,
#: `FORWARDED_ALLOW_IPS` 填錯的話每個請求看起來都來自代理的位址 —— 那個位址
#: 不在這份名單裡,所以症狀是「白名單好像沒作用」;而如果有人把代理位址填進
#: 這份名單來「修好」它,等於**全世界都進了白名單**,IP 層直接失效。
#: 要填的是出口的**公網位址**(在那個網路裡開瀏覽器查 whatismyip 之類)。
#:
#: ⚠️ 不要填 `0.0.0.0/0`、`::/0` 或私有網段(10./172.16./192.168.)來「先擋一下」——
#: 前兩個等於關掉 IP 層,第三個在代理設定正確時根本不會出現,設定錯時則是所有人。
LOGIN_IP_ALLOWLIST = os.environ.get("LOGIN_IP_ALLOWLIST", "").strip()

# 前面有沒有反向代理(nginx / Cloudflare)。
#
# ⚠️ 這個值設錯,IP 那層會從「有效」變成「有害」:
#   該開沒開 —— 後端看到的每個請求都來自代理,所有人共用一個計數器,
#              一個人打錯幾次就把所有人擋在外面。
#   不該開卻開了 —— 任何人都能自己偽造 X-Forwarded-For 標頭換一個假 IP,
#              等於這層完全失效。
#
# 所以預設關閉。nginx 後面的代理信任不靠它,靠 uvicorn 的 FORWARDED_ALLOW_IPS(依來源位址
# 判斷,偽造不了)。這個旗標只留給「uvicorn 前面還有一層
# 它認不出來的代理」的情況。
TRUST_PROXY_HEADER = _env_opt_in("TRUST_PROXY_HEADER")

# ---------------------------------------------------------------- CORS
#
# 允許哪些 origin 跨站打這個 API。**留空 = 完全不掛 CORS 中介層**,而那正是
# 正式環境該有的樣子:前後端由同一個 uvicorn 端出去,同一個 origin,
# 瀏覽器根本不會問。
#
# ⚠️ **不要寫成 `["*"]`。** 以現在的組態可利用性低(token 走 Authorization 標頭、
# 沒開 allow_credentials,別的網站帶不了身分),但那是一道擺著等人踩的設定:
# 哪天 token 改存 cookie、或有人加上 allow_credentials=True,`*` 當場就變成
# 「任何網站都能用使用者的身分打這個 API」。
#
# 本機開發要跨 port(vite 5173 → 後端 8123)才需要填,例如:
#   CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

# ---------------------------------------------------------------- 個人帳號
#
# **一律要登入**,沒有匿名模式:/api/ask 與對話清單都掛 require_user。
# 自己的對話只有自己看得到(過濾做在後端,見 conversations.py)。
#
# 「公開池」(owner IS NULL)是沒有擁有者的對話,新的對話不會落進去 ——
# 程式裡看得到那個詞的地方講的都是它。
#
# ⚠️ 這道隔離擋的是「從網頁上看到別人的對話」。資料庫密碼就在主機的 .env 裡,
# 任何能以服務帳號登入主機的人都直接連得上資料庫讀全部內容 —— 服務跟 .env
# 是同一個帳號,檔案權限擋不住。
#
# 帳號只在資料庫裡(users 表),沒有種子檔。
# 發下去的預設密碼。建帳號與重設密碼時發的就是這一組,系統也靠它認得
# 「這個人還沒改過密碼」並強制他改 —— 預設密碼所有人同一組,在他改掉之前,
# 知道那組密碼的人就能用他的帳號登入,「只有自己看得到」對他還不成立。
#
# 留空(或停在範本的佔位字串)的話,建帳號與重設密碼一律被拒絕(回 409,
# 見 routers/admin_users._require_default_password)。
#
# ⚠️ **沒有預設值。** 寫在這裡的字面值等於寫在版控裡的初始密碼:
# 拿它登入任何還沒改密碼的帳號 → `/api/password` 改掉 → 帳號易主。
# 要用就在 .env 設,而且發完一輪之後就換掉。
DEFAULT_USER_PASSWORD = os.environ.get("DEFAULT_USER_PASSWORD", "")

#: 範本的佔位字串,一律當成「還沒設」(同 ADMIN_PASSWORD_PLACEHOLDERS 的理由)。
#:
#: ⚠️ 只擋**範本裡的佔位文字**,不是密碼政策 —— 長度與複雜度一律不管。
DEFAULT_USER_PASSWORD_PLACEHOLDERS = frozenset({"請改成一組只有管理員知道的初始密碼", "changeme"})


def default_user_password_is_usable() -> bool:
    """建帳號 / 重設密碼之前要先過這關:沒設就沒有初始密碼可以發,那兩個動作要拒絕,
    不能退回任何寫在程式裡的字串。"""
    return bool(DEFAULT_USER_PASSWORD) and DEFAULT_USER_PASSWORD not in DEFAULT_USER_PASSWORD_PLACEHOLDERS


# ---------------------------------------------------------------- SSH 終端機(/ssh)
#
# 側邊欄的「SSH Server」:工程師(職稱 Software engineer)與管理員點了就直接以
# **這裡設定的**帳號連進主機,畫面上沒有任何表單。
# 所以這一組就是「連到哪、用誰、拿什麼憑證」的唯一來源。
#
# 走真的 SSH 到 sshd,不是在服務裡直接 fork 一個 shell:服務自己的身分(容器或服務帳號)
# fork 出來的 shell 權限與環境都不對;走 SSH 拿到的是跟一般 SSH 用戶端一模一樣的登入 session,
# sshd 的登入紀錄也照留。
SSH_TERMINAL_ENABLED = _env_enabled("SSH_TERMINAL_ENABLED", default=True)
SSH_TERMINAL_HOST = os.environ.get("SSH_TERMINAL_HOST", "127.0.0.1")
SSH_TERMINAL_PORT = int(os.environ.get("SSH_TERMINAL_PORT", "22"))
SSH_TERMINAL_USER = os.environ.get("SSH_TERMINAL_USER", "tiptop")
# 憑證二選一。**建議用金鑰**:產一對、把公鑰加進登入帳號的 ~/.ssh/authorized_keys
# (Docker 的放法見 deploy/docker/ssh/README.md),.env 裡就不會有明文密碼;
# 要收回只要刪那一行公鑰。密碼那條留給「主機不允許金鑰登入」的情況。
# 兩個都空 = 功能視為關閉(開機時 warning 一次,側邊欄不顯示那一列),
# 不是連的時候才炸。
SSH_TERMINAL_KEY_FILE = os.environ.get("SSH_TERMINAL_KEY_FILE", "")
SSH_TERMINAL_PASSWORD = os.environ.get("SSH_TERMINAL_PASSWORD", "")
# 主機金鑰。**沒有表單就沒有地方按「信任」**,所以部署時先用 ssh-keyscan 寫好
# (見 deploy/docker/ssh/README.md);
# 檔案不存在或對不上一律拒連(不是靜默放行)—— 內網也不該對 MITM 完全不設防。
SSH_TERMINAL_KNOWN_HOSTS = os.environ.get(
    "SSH_TERMINAL_KNOWN_HOSTS", str(DATA_DIR / "ssh_known_hosts")
)
# 檔案欄一開始停在哪。`~` = 登入帳號的家目錄(連上後向 sshd 問)。
SSH_TERMINAL_START_DIR = os.environ.get("SSH_TERMINAL_START_DIR", "~")
#: 一個網站帳號同時最多開幾條(可以用頁籤多開)。每一條都是主機上一個
#: sshd session + 一條 SFTP。
SSH_TERMINAL_MAX_SESSIONS = int(os.environ.get("SSH_TERMINAL_MAX_SESSIONS", "4"))

#: 終端機旁邊的 AskME 用哪個模型。**跟問答的 CLAUDE_MODEL 分開**:問答那邊為了省錢改成
#: sonnet 的時候,這個面板不跟著變。只收白名單裡的值,其他退回 opus。
TERMINAL_AI_MODEL = os.environ.get("TERMINAL_AI_MODEL", "opus")
if TERMINAL_AI_MODEL not in ALLOWED_MODELS:
    TERMINAL_AI_MODEL = "opus"

# 幾秒沒有鍵盤輸入、也沒有檔案操作就自動斷線。
#
# ⚠️ **預設 0 = 閒置不斷線。** 預設的規則只有兩條:前端閒置 3 分鐘蓋上主機清單當
# **螢幕保護**(`SCREENSAVER_IDLE_MS`,那不是斷線,點回去就繼續);**關掉網頁 / 離開
# 那一頁才斷**(WebSocket 一關就收)。要自動斷線就在 .env 填秒數(例如 600)。
#
# ⚠️ 關掉自動斷線之後,**擋在前面的變成 nginx 的 `proxy_read_timeout`**(範本 660s):
# 一條沒人動的 WebSocket 會被它切掉,而使用者看到的原因會是「網路中斷」——
# 所以有 `SSH_TERMINAL_KEEPALIVE_SEC`(底下)定期送一則訊息把它撐住。兩個要一起看。
# ⚠️ 純輸出不算活動(`tail -f` 不會讓 idle 歸零),這在 idle 打開時仍然成立。
SSH_TERMINAL_IDLE_TIMEOUT_SEC = int(os.environ.get("SSH_TERMINAL_IDLE_TIMEOUT_SEC", "0"))
# 幾秒送一則 keepalive(`{"type":"ping"}`)。它跟閒置計時無關(那一頭看的是使用者的動作,
# 不是這個)。**這一個值同時做兩件事**,改它之前兩件都要想過:
#   ① 瀏覽器 ↔ nginx ↔ 這裡:讓中間的 proxy 看到有流量,不然沒人動的 WebSocket 會被
#      `proxy_read_timeout` 切掉(見下面 240 的來源)。送不出去就代表對面已經走了,
#      橋接那頭會收線並記成 `network`(`terminal.py` 的 keepalive task)。
#   ② 這裡 ↔ 主機那條 SSH:同一個值當 asyncssh 的 `keepalive_interval`
#      (`terminal.py` 的 `_connect`),於是「後端多久發現主機那頭死了」是
#      這個值 × asyncssh 的 `keepalive_count_max`(預設 3)。經過跳板或 NAT 的主機,
#      中間的設備會悄悄回收連線,少了它會留一條看起來還在的殼。
# ⚠️ 調小的話兩邊的偵測都變快、流量也變多;調成 0 是**兩邊都關掉**,不只是 ①。
#
# 240 的來源:要**明顯小於** nginx 範本的 `proxy_read_timeout 660s`,而且小到即使
# 有人把那個值調成常見的 300 也還撐得住。前端收到不認得的 type 會直接忽略
# (`lib/terminalApi.ts` 的 message handler)。
# 0 = 不送(那就只能靠 nginx 那邊自己調長)。
SSH_TERMINAL_KEEPALIVE_SEC = int(os.environ.get("SSH_TERMINAL_KEEPALIVE_SEC", "240"))
# 連 sshd 的逾時。主機沒在聽的時候要在這個秒數內告訴使用者「連不上」。
SSH_TERMINAL_CONNECT_TIMEOUT_SEC = int(os.environ.get("SSH_TERMINAL_CONNECT_TIMEOUT_SEC", "10"))


def ssh_terminal_available() -> bool:
    """開關開著、而且憑證至少設了一種。`/api/me` 的 can_terminal 與 WebSocket 都問這支。

    是函式不是常數:測試要能 monkeypatch 上面那幾個值,而且要在**同一個判斷**
    上一致 —— 側邊欄那一列顯不顯示、WebSocket 讓不讓連,讀的是同一個答案。
    """
    return bool(SSH_TERMINAL_ENABLED and (SSH_TERMINAL_KEY_FILE or SSH_TERMINAL_PASSWORD))


# ---------------------------------------------------------------- Work Flow(排程拼圖,可選)
#
# 每塊拼圖跑什麼指令,寫在這個 json。**有這個檔、而且 SSH 終端機可用(`ssh_terminal_available()`)
# 才啟用 Work Flow**:否則 /api/workflows 一律 404、排程器不啟動、側邊欄沒有那一列
# (三處都問 `workflows.available()`)。要用就把 workflow_actions.example.json
# 複製成 workflow_actions.json 再改,改完重啟服務(跟 terminal_hosts.json 一樣只讀一次)。
# 這個檔**不在版控裡**(每台主機要跑的指令都不一樣)。
# ⚠️ json 裡**不放密碼**,指令要用的祕密放在主機上(sudoers、金鑰、指令自己讀的設定檔)。
WORKFLOW_ACTIONS_FILE = Path(
    os.environ.get("WORKFLOW_ACTIONS_FILE", str(BASE_DIR / "workflow_actions.json"))
)
# 排程用的時區,以「比 UTC 快幾分鐘」表示。預設 +480(UTC+8,沒有日光節約);
# 不用 zoneinfo 是因為 Windows 開發機沒有時區資料庫(要另外裝 tzdata),而這裡只需要一個位移。
WORKFLOW_UTC_OFFSET_MIN = int(os.environ.get("WORKFLOW_UTC_OFFSET_MIN", "480"))
# 排程器多久看一次(秒)。到點之後最慢晚這麼久才觸發。
WORKFLOW_TICK_SEC = float(os.environ.get("WORKFLOW_TICK_SEC", "20"))
# Work Flow「通知人員」寫的那組對話(`workflow-<流程 id>`)掛在誰名下。刻意用一個
# **不存在於 users 表**的名字:它只是紀錄的擁有者標籤,沒有密碼、登不進網頁。
# ⚠️ 用量統計**不算**這個名字寫的那幾題(`stats._apply_range`)—— 它們是執行結果,不是有人問的問題。
WORKFLOW_OWNER = os.environ.get("WORKFLOW_OWNER", "work-flow")


def is_workflow_result(owner, asked_by) -> bool:
    """這一題是不是 Work Flow 通知寫進去的「這次的結果」(對話頁不畫、搜尋不搜,見 workflow_engine._post_note)。
    **整個專案只有這一條規則**:擁有者是 WORKFLOW_OWNER、送出的人也是(asked_by 是空的就退回 owner)。
    有人在那組對話裡追問的那幾題,owner 一樣是 WORKFLOW_OWNER,但送出的是真人 —— 那些照畫、照搜。"""
    return owner == WORKFLOW_OWNER and (asked_by or owner) == WORKFLOW_OWNER


# ---------------------------------------------------------------- 登入的地理封鎖
#
# 只讓台灣 IP 登入。判定與政策在 `app/geoip.py`,擋的點在 `routers/auth.py`
# 的登入(密碼對了也不發 token)。
#
# ⚠️ **預設關閉,而且要先跑試跑模式。** 政策是「判不出國別一律擋、沒有例外」,
# 那代表 `FORWARDED_ALLOW_IPS` 一設錯(client_ip 對所有人回 127.0.0.1)就是**全員鎖死**。
# 上線步驟:先設 dryrun,在稽核頁確認 `login_geo_dryrun` 沒有誤擋自己人,再改 enforce。
# ⚠️ **一個三態的設定,不是兩個布林。** 不要拆成 `GEO_BLOCK_ENABLED` + `GEO_BLOCK_DRY_RUN`
# 兩個 `_env_enabled(...)`:那支的規則是「非否定字即為真」,所以 `GEO_BLOCK_DRY_RUN=ture`
# 會**靜默**變成「真的擋」。那正好是這個功能最貴的誤動作(全員鎖死),不能靠打字正確來保證。
#
# 三態把方向問題整個消掉:沒有「哪一邊是安全的預設」要推理,而且**看不懂的值
# 會當場讓服務起不來**(`main.init_database()`),不會靜默選一邊。
#   off     = 什麼都不做(預設,也是留空時的值)
#   dryrun  = 只記錄不擋,稽核寫 `login_geo_dryrun` —— 上線前先跑這個
#   enforce = 真的擋
GEO_BLOCK_MODES = ("off", "dryrun", "enforce")
#: 原始字串留著給啟動檢查看(`geo_block_mode_error()`)。
GEO_BLOCK_MODE = (os.environ.get("GEO_BLOCK_MODE") or "off").strip().lower()
#: 底下兩個是**推導出來的**,給呼叫端用的形狀 —— 別的模組不必認得模式字串。
GEO_BLOCK_ENABLED = GEO_BLOCK_MODE in ("dryrun", "enforce")
GEO_BLOCK_DRY_RUN = GEO_BLOCK_MODE == "dryrun"


def geo_block_mode_error() -> str:
    """`GEO_BLOCK_MODE` 填了看不懂的東西時回一句話,正常時回空字串。

    **不在模組層 raise**:import 不該有副作用(測試、工具腳本都會 import config),
    檢查留到 `main.init_database()` 開機時做(跟 ADMIN_PASSWORD 那條同一個理由)。
    """
    if GEO_BLOCK_MODE in GEO_BLOCK_MODES:
        return ""
    return (
        f"GEO_BLOCK_MODE 填了看不懂的值({GEO_BLOCK_MODE!r})—— "
        f"只能是 {' / '.join(GEO_BLOCK_MODES)}。\n"
        "這個設定控制的是「非台灣 IP 能不能登入」,猜錯一邊的代價是全公司登不進來,"
        "所以寧可不啟動也不要當成關閉。"
    )
# 台灣網段清單。進版控,重建方式見 backend/build_tw_ranges.py。
TW_RANGES_FILE = Path(os.environ.get("TW_RANGES_FILE", str(BASE_DIR / "tw_ranges.txt")))


# ---------------------------------------------------------------- 終端機的主機清單
#
# 進 /ssh **不會自動連線**,先看主機清單(每台一張卡片),點哪一台才連哪一台。幾台主機、怎麼跳是**部署設定**不是程式,
# 所以寫在一個 json:啟動時讀一次,改完重啟服務就生效。
#
# ⚠️ 這個檔**不在版控裡**(每台機器的主機與憑證都不一樣),範本是 terminal_hosts.example.json。
# ⚠️ **json 裡也不放密碼**:要用密碼登入的主機填 `password_env`(環境變數的**名字**),
# 真正的值在 .env。json 會被複製、貼進範本、拿去問人;.env 只留在那台機器上。
TERMINAL_HOSTS_FILE = Path(
    os.environ.get("TERMINAL_HOSTS_FILE", str(BASE_DIR / "terminal_hosts.json"))
)


class TerminalHost(TypedDict):
    """終端機主機清單上的**一台主機**。

    這是 `terminal_hosts.json` 一筆條目正規化之後的樣子,也是 `terminal.py`、
    `routers/terminal.py` 一路傳下去的東西。前端有對應的 `TerminalHost`
    (`lib/terminalApi.ts`),兩邊的欄位名要對得起來。

    ⚠️ 用 `TypedDict` 而不是 dataclass:這些值本來就是 json 解出來的 dict,
    而且 `public_terminal_hosts()` 要直接丟進 JSON 回應。TypedDict 是**純型別**,
    執行期完全沒有東西改變(不會多一次轉換、不會有新的失敗點),
    但 `host["prot"]` 這種打錯字型別檢查抓得到,不必等到主機連不上才發現。

    ⚠️ **不放密碼**:要用密碼登入的主機填 `password_env`(環境變數的名字),
    真正的值在 .env(理由見 TERMINAL_HOSTS_FILE)。
    """

    id: str
    label: str
    sub: str
    #: 跳板的 id(ProxyJump)。填了就先連那一台,再從那條連線裡連這一台。
    via: str
    host: str
    port: int
    user: str
    key_file: str
    password_env: str
    known_hosts: str
    start_dir: str


def terminal_host_label(host: "TerminalHost") -> str:
    """給人看的標籤。json 填了 `label` 就用它,否則 `帳號@主機`。

    目標是 loopback 時用服務所在機器的主機名 —— `user@127.0.0.1` 沒有人看得出是哪一台。
    """
    label = (host.get("label") or "").strip()
    if label:
        return label
    name = host.get("host") or ""
    if name in ("127.0.0.1", "localhost", "::1"):
        import socket

        name = socket.gethostname().split(".")[0] or name
    return f"{host.get('user') or ''}@{name}"


def _terminal_host_from_env() -> dict:
    """沒有 terminal_hosts.json 時的那一台:就是 .env 裡的 SSH_TERMINAL_*。

    **開發機與只有一台主機的部署走的都是這條**,所以主機清單上照樣有一張卡片可以點,
    不必先生一個設定檔。
    """
    return {
        "id": "main",
        # SSH Server 的選連線畫面上顯示成「主機」;沒填 label 的話會顯示成「帳號@主機」
        "label": "主機",
        "sub": "",
        "via": "",
        "host": SSH_TERMINAL_HOST,
        "port": SSH_TERMINAL_PORT,
        "user": SSH_TERMINAL_USER,
        "key_file": SSH_TERMINAL_KEY_FILE,
        "password_env": "SSH_TERMINAL_PASSWORD",
        "known_hosts": SSH_TERMINAL_KNOWN_HOSTS,
        "start_dir": SSH_TERMINAL_START_DIR,
    }


def _load_terminal_hosts_file() -> list[TerminalHost]:
    """讀 terminal_hosts.json。檔案不在就是空的 —— 那時候走 .env 那一台(見 `terminal_hosts`)。"""
    try:
        raw = json.loads(TERMINAL_HOSTS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    hosts: list[TerminalHost] = []
    for entry in raw.get("hosts", []):
        host_id = str(entry.get("id") or "").strip()
        if not host_id or not entry.get("host"):
            # 少了 id 或位址的那一筆**跳過就好,不要讓整份設定失效** —— 一個打錯字的
            # 條目不該讓所有人的終端機都用不了。漏掉的那一台在 log 裡看得到。
            logger.warning("terminal_hosts.json 有一筆缺 id 或 host,略過:%r", entry)
            continue
        hosts.append(
            {
                "id": host_id,
                "label": str(entry.get("label") or ""),
                "sub": str(entry.get("sub") or ""),
                # 跳板的 id(ProxyJump)。填了就先連那一台,再從那條連線裡連這一台。
                "via": str(entry.get("via") or ""),
                "host": str(entry.get("host") or ""),
                "port": int(entry.get("port") or 22),
                "user": str(entry.get("user") or SSH_TERMINAL_USER),
                "key_file": str(entry.get("key_file") or ""),
                "password_env": str(entry.get("password_env") or ""),
                # 沒填就共用主設定那一份(同一台機器上 keyscan 出來的)。
                "known_hosts": str(entry.get("known_hosts") or SSH_TERMINAL_KNOWN_HOSTS),
                "start_dir": str(entry.get("start_dir") or "~"),
            }
        )
    return hosts


#: 設定檔裡的那幾台。**啟動時只讀一次**,改了要重啟服務。
_TERMINAL_HOSTS_FILE_ENTRIES = _load_terminal_hosts_file()


def terminal_password_env_names(path: Path) -> tuple[str, ...]:
    """terminal_hosts.json 裡所有 `password_env` 的名字。

    **讀原始 json、不看條目合不合法**:被 `_load_terminal_hosts_file` 略過的那一筆(缺 id 或 host 之類),
    它指的密碼一樣在 .env 裡、一樣會被子行程繼承。
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ()
    hosts = raw.get("hosts", []) if isinstance(raw, dict) else []
    names = {str(e.get("password_env") or "").strip() for e in hosts if isinstance(e, dict)}
    return tuple(sorted(n for n in names if n))


# 各主機的密碼也不能流進 agent / 終端機 AI 的子行程:拿得到 Bash 的帳號跑一次 `env` 就看得到。
# 設定檔只讀一次,這裡也只算一次;改了 terminal_hosts.json 本來就要重啟。
SECRET_ENV_KEYS = SECRET_ENV_KEYS + tuple(
    n for n in terminal_password_env_names(TERMINAL_HOSTS_FILE) if n not in SECRET_ENV_KEYS
)


def terminal_hosts() -> list[TerminalHost]:
    """現在有哪幾台可以連。

    ⚠️ **是函式不是常數**:沒有設定檔時那一台是從 `SSH_TERMINAL_*` **當下的值**組出來的,
    而測試會 monkeypatch 那幾個變數(見 test_terminal_bridge.py)。在模組層算好一份的話,
    測試 patch 完拿到的仍是 import 當下的位址 —— 連到的會是真的那台主機,不是假的 sshd。
    """
    return _TERMINAL_HOSTS_FILE_ENTRIES or [_terminal_host_from_env()]


def find_terminal_host(host_id: str) -> Optional[dict]:
    """照 id 找一台。找不到回 None —— **不要退回第一台**:瀏覽器送了一個不認識的 id,
    那是前後端對不上或有人在亂試,靜靜連到別台是最糟的處理方式(連錯環境)。"""
    for host in terminal_hosts():
        if host["id"] == host_id:
            return host
    return None


def default_terminal_host() -> dict:
    """沒指定的時候連哪一台 —— 清單上的第一台。請求沒帶 host 時走這條。"""
    return terminal_hosts()[0]


def public_terminal_hosts() -> list[dict]:
    """給瀏覽器的那一份:**只有 id / 名字 / 副標 / 經過誰**。

    ⚠️ 位址、帳號、憑證一個都不能出去。主機卡片只需要畫得出來就好,
    而「連到哪、用誰」永遠是伺服器這邊決定的。
    """
    return [
        {
            "id": h["id"],
            "label": terminal_host_label(h),
            "sub": h["sub"],
            "via": h["via"],
        }
        for h in terminal_hosts()
    ]
