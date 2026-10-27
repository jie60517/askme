import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, ratelimit, security, usage_limit
from . import auth as auth_dep
from .database import Base, close_orphan_runs, engine, purge_expired_steps
from .routers import (
    admin_users,
    ask,
    audit,
    auth,
    conversations,
    files,
    folders,
    geo_allow,
    locks,
    notebook,
    notes,
    stats,
    terminal,
    workflows,
)

logger = logging.getLogger(__name__)


def init_database() -> None:
    """建表、收尾。**服務真的要開始服務時才跑**,不是 import 時。

    ⚠️ **這幾件事不能放在模組層**(那樣 `from app.main import app` 當下就會全部
    執行一次)。測試、`python -m app.migrate_sqlite` 這類工具都會 import app 的模組,
    而那時服務可能正在用同一份資料庫 —— 放在模組層的話 `close_orphan_runs()` 會把
    所有 status="running" 標成中斷,它分不出那是上次關機留下的,還是**有人此刻
    正在問的題目**;兩個行程也會同時寫同一個 SQLite 檔。
    `backend/tests/conftest.py` 把 DATABASE_URL 指到暫存目錄,是擋同一件事的
    第二道防線,不是唯一那道。

    ⚠️ 順序不能換:`create_all` → 收尾。後面每一步都假設表已經在了。
    """
    # ⚠️ **管理員密碼是空的、或還停在範本的佔位字串,就不要開機。**
    #
    # 沒有設定時的預設 tiptop / tiptop 照常開機(剛 clone 下來就能看畫面,
    # 上線前要改,見 config.ADMIN_PASSWORD 的說明)。擋的是一看就是佔位的那幾句
    # (config.ADMIN_PASSWORD_PLACEHOLDERS):那些字串是公開的,而管理員拿的是
    # ALLOWED_TOOLS_FULL(含 Bash,不吃 --add-dir),照常開機等於把主機的任意指令
    # 執行權交給任何看過範本的人 —— 寧可起不來。
    #
    # 擋在 init_database() 而不是模組層,理由同上:import 不該有副作用。
    if not config.admin_password_is_usable():
        raise RuntimeError(
            "ADMIN_PASSWORD 是空的或還停在範本的佔位字串。"
            "請把 ADMIN_PASSWORD= 改成真正的密碼再啟動(本機在 backend/.env,Docker 在 askme.env)。"
        )

    Base.metadata.create_all(bind=engine)
    # **強制手機驗證開著、但管理員自己還沒綁 —— 寧可起不來。**
    #
    # 那個狀態沒有任何出路:所有人(含管理員)登入都會被 403 擋掉,而唯一能發
    # QR code 的人就是管理員。服務起來了反而更糟 —— 大家會一個一個試、把帳號
    # 鎖掉,然後才有人想到要看 .env。在這裡當場失敗、把該做的事寫在訊息裡,
    # 是唯一能讓人在三十秒內解決的做法。
    #
    # ⚠️ 要放在 `create_all()` **之後**:它查的是 user_mfa 那張表,
    # 而那張表可能是這次開機才建起來的。
    if config.MFA_REQUIRED:
        from . import mfa

        if not mfa.is_enabled(config.ADMIN_USERNAME):
            raise RuntimeError(
                f"MFA_REQUIRED 開著,但管理員帳號({config.ADMIN_USERNAME})"
                "還沒有手機驗證碼 —— 這樣啟動的話所有人都會被擋在門外,"
                "包含唯一能發 QR code 的你。\n"
                "正確順序:先把 MFA_REQUIRED 設回 0 並啟動 → 用密碼登入 → "
                "在帳號管理頁最上面那張卡片產生 QR code 並掃描 → "
                "把每個同仁也發完 → 最後才把 MFA_REQUIRED 設成 1 重啟。"
            )

    # **地理封鎖:設定看不懂、或清單是空的 —— 兩種都寧可起不來。**
    #
    # 政策是 fail-closed(判不出國別就擋),所以這兩種錯的後果一模一樣:服務起得來、
    # 所有人登不進去,而且畫面上的訊息是刻意不透露原因的那一句,沒有人看得出真正的原因。
    # 當場失敗、把該做的事寫在訊息裡,才有得救(跟上面 MFA_REQUIRED 那條同一個理由)。
    mode_error = config.geo_block_mode_error()
    if mode_error:
        raise RuntimeError(mode_error)

    if config.GEO_BLOCK_ENABLED:
        from . import geoip

        if not geoip.default_ranges().count:
            raise RuntimeError(
                f"GEO_BLOCK_MODE={config.GEO_BLOCK_MODE},但台灣網段清單讀不到或是空的"
                f"({config.TW_RANGES_FILE})—— 這樣啟動的話所有人都會被擋在門外。\n"
                "重建:cd backend && .venv/bin/python build_tw_ranges.py\n"
                "或先把 GEO_BLOCK_MODE 設回 off 再啟動。"
            )

    # 帳號只在資料庫裡,沒有種子檔:全新的資料庫由管理員登入帳號管理頁建第一個帳號。
    # 上次關機時還在跑的問答收尾,否則畫面上會永遠卡在「回答中」
    close_orphan_runs()

    # 上次被鎖住的 IP 載回記憶體(重啟不等於解鎖)。要放在這裡而不是第一次用到時才載 ——
    # 懶載入的話,重啟後最先撞進來的那幾次請求會在名單還沒載好時被放行。
    #
    # ⚠️ 要在 `create_all()` 之後:它查的是 login_ip_blocks 那張表。
    restored = ratelimit.load_persisted_blocks()
    if restored:
        logger.info(
            "載回 %d 個仍在封鎖中的 IP(要解開:管理員在「安全」頁按解鎖)", restored
        )
    # 過期的每步流水帳。放在最後 —— 它純粹是打掃,失敗也不該擋住服務起來,
    # 而前面每一步都是「不做就會壞」的。理由見 config.QA_STEPS_RETENTION_DAYS。
    purged = purge_expired_steps()
    if purged:
        logger.info("流水帳清理:刪掉 %d 列超過保留期的每步明細", purged)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """ASGI 生命週期。`uvicorn app.main:app` 會跑它,單純的 import 不會。

    ⚠️ `TestClient(app)` **不包 `with` 的話不會觸發這裡**(Starlette 的規矩)。
    需要資料庫的測試要自己建表,或改用 `with TestClient(app) as client:`。
    """
    init_database()
    # SSH 終端機:開關開著卻沒給任何憑證 → 側邊欄不會有那一列、WebSocket 回 4404,
    # 但那是「安靜地沒有」。開機時講一次,免得部署完找不到那顆鈕還以為前端壞了。
    if config.SSH_TERMINAL_ENABLED and not config.ssh_terminal_available():
        logger.warning(
            "SSH 終端機:SSH_TERMINAL_ENABLED 是開的,但 SSH_TERMINAL_KEY_FILE 與 "
            "SSH_TERMINAL_PASSWORD 都沒設 —— 功能視為關閉。見 deploy/env.server.example。"
        )
    # Work Flow(可選,主機上有 workflow_actions.json 才開):上次關機還在跑的標成失敗、
    # 排程從「現在」重算(停機期間錯過的不補跑),然後起排程器。沒開就什麼都不做。
    from . import workflow_engine
    from . import workflows as workflows_mod

    scheduler = None
    if workflows_mod.available():
        import asyncio

        orphans = workflow_engine.close_orphan_workflow_runs()
        if orphans:
            logger.info("Work Flow:%d 筆上次關機時還在跑的執行標成失敗", orphans)
        workflow_engine.reschedule_all()
        scheduler = asyncio.get_running_loop().create_task(workflow_engine.scheduler_loop())
    yield
    if scheduler is not None:
        scheduler.cancel()
        # 還在跑的流程先停、讓它們斷掉 VPN,再收終端機
        await workflow_engine.shutdown()
    # 服務關閉:把還開著的終端機 session 收掉,不留 sshd 那頭的殭屍。
    from . import terminal as terminal_mod

    await terminal_mod.close_all("server")


# ⚠️ **互動式 API 文件一律關掉**(`/docs`、`/redoc`、`/openapi.json`)。
#
# FastAPI 預設**匿名**端這三條出去,而 `/openapi.json` 裡是完整的端點清單與
# 每一個請求/回應的 schema —— 等於把「這台主機有哪些 API、每條吃什麼參數」
# 整理好送給任何一個路人。
#
# 這跟 `/api/config` 要登入是同一件事的兩半:那邊擋掉了專案清單,
# 這邊要擋掉 API 目錄。只做一半的話,對方照樣從 `/openapi.json` 讀得到
# `/api/users`、`/api/terminal/*` 這些路徑存在,然後挑著試。
#
# 內部要看文件的話,在本機把這三個值設回來就有(那是開發機,不對外)。
app = FastAPI(
    title="問我問我",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# CORS **只給本機開發用**(vite dev server 在 5173,後端在 8100/8123,跨 origin)。
#
# ⚠️ 正式環境**根本不需要這一段**:前後端由同一個 uvicorn 端出去,同一個 origin,
# 瀏覽器不會發 preflight,這個中介層一次都不會生效。
#
# ⚠️ **不要寫成 `allow_origins=["*"]`。** 實際可利用性低 —— token 走 Authorization
# 標頭而不是 cookie,而且沒開 `allow_credentials`,所以別的網站叫瀏覽器打過來時
# 帶不了身分。但它是一道**擺在那裡等人踩**的設定:哪天有人把 token 改成 cookie、
# 或加上 `allow_credentials=True`,`*` 當場變成「任何網站都能用使用者的身分
# 打這個 API」。設定放寬的代價通常不是當下,是下一個改動的人不知道它放寬過。
#
# 要在別的機器上開發就設 `CORS_ORIGINS=http://192.168.x.x:5173`(逗號分隔)。
if config.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# 兩道站在路由之前的防線(理由見 security.py):請求本文大小、回應安全標頭。
# ⚠️ 後加的中介層包在外層,所以 BodySizeLimit 要最後 add 才會最先看到請求 ——
# 超大的 body 在任何人碰它之前就被 413 掉。
app.add_middleware(
    security.SecurityHeaders,
    index_html=Path(__file__).resolve().parent.parent.parent / "frontend" / "dist" / "index.html",
)
app.add_middleware(
    security.BodySizeLimit,
    max_bytes=config.MAX_REQUEST_MB * 1024 * 1024,
    anon_max_bytes=config.ANON_MAX_REQUEST_KB * 1024,
)

app.include_router(ask.router)
app.include_router(stats.router)
app.include_router(files.router)
app.include_router(auth.router)
app.include_router(conversations.router)
app.include_router(folders.router)
app.include_router(notes.router)
app.include_router(notebook.router)
app.include_router(locks.router)
app.include_router(geo_allow.router)
app.include_router(audit.router)
app.include_router(admin_users.router)
app.include_router(terminal.router)
# Work Flow 的路由一律掛著,沒開的時候整組回 404(routers/workflows 的 _require_available)——
# 測試與 /api/me 才能在同一個行程裡看到「開」與「沒開」兩種答案
app.include_router(workflows.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def get_config(_viewer: str = Depends(auth_dep.require_user)):
    """前端問答頁的設定。**要登入,而且要已經改掉預設密碼。**

    ⚠️ 這份回應裡的 `knowledge_bases` 標籤等於一份**專案清單**。匿名可讀的話,
    任何路人打開 `/api/config` 就能列舉這台主機放了哪些專案 —— 那可能是敏感資訊。

    要登入不影響登入流程:登入頁本身**不呼叫**這支(只有登入後的問答頁
    `frontend/src/pages/Chat.tsx` 會抓),所以擋掉匿名不會擋到登入流程。

    ⚠️ 這裡**刻意用 `require_user` 而不是 `require_any_user`**:`frontend/src/App.tsx`
    的 gate 是 `password_is_default` 就**只渲染** `ForcePasswordChange`,Chat 根本不掛載,
    而那一頁不呼叫這支。沒有任何呼叫端需要那個放寬,放寬只會讓
    「還在用預設密碼的 token 也讀得到專案清單」。`require_any_user`
    只給還沒改密碼的人也必須到得了的路徑(見 auth.py),這裡不是。
    """
    return {
        "default_model": config.CLAUDE_MODEL,
        # 白名單交給後端定,前端只負責把它翻成看得懂的名字 ——
        # 兩邊各寫一份的話,哪天這裡加了模型,前端會顯示一個送出去就被打回的選項。
        # 順序照 MODEL_MENU_ORDER(能力高的在前);
        # 白名單裡有、排序表沒列到的接在後面,不會因為忘了排就消失。
        "allowed_models": [m for m in config.MODEL_MENU_ORDER if m in config.ALLOWED_MODELS]
        + sorted(config.ALLOWED_MODELS - set(config.MODEL_MENU_ORDER)),
        # 專案清單(json 列的 + workspace 底下的資料夾,每次重掃)。只回傳 id / 標籤 / 範例問題 /
        # 預設模型 —— 主機上的絕對路徑沒必要送到瀏覽器,那是內部佈署細節。
        "knowledge_bases": [
            {
                "id": b["id"],
                "label": b["label"],
                "suggestions": b["suggestions"],
                # 這個專案的預設模型(選填,不在白名單就當沒填)。前端的優先序:
                # 這組對話手動選的 → **這裡** → 個人常用 → 全站預設(lib/modelPref.ts 的 pickModel)。
                "default_model": b.get("default_model")
                if b.get("default_model") in config.ALLOWED_MODELS
                else None,
            }
            for b in config.knowledge_bases()
        ],
        "default_knowledge_base": config.default_knowledge_base(),
        # 單檔上限,預設 50 MB;0 才是不限制。前端拿它在送出前就擋掉太大的檔案,
        # 不先擋的話使用者要等整個檔案傳完才會被告知失敗。
        "max_upload_mb": config.MAX_UPLOAD_MB,
        # 同時處理幾題。排隊訊息要講「主機同時只能跑 N 題」才有說服力。
        "max_concurrent_asks": config.MAX_CONCURRENT_ASKS,
    }


@app.get("/api/usage-limit")
async def get_usage_limit(fresh: bool = False, _viewer: str = Depends(auth_dep.require_user)):
    """Claude 訂閱額度的快照:用掉幾 %、剩幾 %、幾分鐘後重置、這次多用了幾 %。

    前端在**每一題答完**打一次,小夥伴接著把它唸出來。

    ⚠️ **讀不到就回一個 `available: false`,不要回 500。** 這支的資料來源是
    claude CLI 的 `/usage`,而那段輸出的格式是 CLI 給的、升版就可能變
    (剖法與取捨全部寫在 `app/usage_limit.py` 的檔頭)。回 500 的話,前端每答完
    一題都會在主控台留一條紅字,而這其實只是一個「附加的一句話」沒講成 ——
    答案本身完全正常。前端看到 available:false 就只顯示「回答完成」。

    `?fresh=1`:答完那一次要的是**現在**的水位,不吃 60 秒快取(理由見
    `usage_limit.read_usage_limit`)。送出那一次不帶,吃快取就好。

    要登入:額度是這台主機的營運資訊,不該給路人看。
    """
    snapshot = await usage_limit.read_usage_limit(fresh=fresh)
    if snapshot is None:
        return {"available": False}
    return {"available": True, **snapshot}


# 部署時執行過 `npm run build` 才會有 frontend/dist,本機開發用 vite dev server
# 另外跑在 5173,不會用到這段;正式環境靠這段讓 uvicorn 一個 port 把前後端都端出去。
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

class _HashedAssets(StaticFiles):
    """`/assets` 底下那些**檔名帶內容雜湊**的檔案(`index-Dr68Pp7X.js`)。

    內容變了檔名就變,所以同一個網址的內容永遠不會改 —— 這正是 `immutable` 說的事:
    瀏覽器連「回來問一次」都不必。少了這個標頭不會拿到舊的(檔名不同就是不同請求),
    但每次開站都要為這些檔各發一次 304,而那些往返一次都不需要。
    """

    def file_response(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if FRONTEND_DIST.exists():
    app.mount("/assets", _HashedAssets(directory=FRONTEND_DIST / "assets"), name="frontend-assets")

    _DIST_ROOT = FRONTEND_DIST.resolve()
    _INDEX = _DIST_ROOT / "index.html"

    # ⚠️ **`index.html` 一定要標成「每次都回來問」。**
    #
    # 少了它的症狀:主機上明明是新版,使用者開 `/` 看到的還是舊畫面,
    # 而沒開過的路徑(例如 `/stats`)就是新的 —— 開過的那頁被瀏覽器快取住了。
    #
    # 回應**沒有 Cache-Control** 時,瀏覽器會自己「猜」
    # 一個快取時間(常見是距離 Last-Modified 的 10%),於是每次上版都會有人
    # 看到舊畫面 —— 而症狀長得像部署失敗,實際上部署是好的。
    #
    # `no-cache` **不是**「不要快取」,是「可以存,但每次用之前要回來驗一次」。
    # 配上既有的 ETag,沒改版時回 304(幾乎不花流量),改版了才真的重新下載。
    #
    # ⚠️ `assets/` 底下**不要**加這個,它們走 `_HashedAssets`(理由寫在那支的 docstring)。
    _REVALIDATE_HEADERS = {"Cache-Control": "no-cache"}

    def _index_response() -> FileResponse:
        return FileResponse(_INDEX, headers=_REVALIDATE_HEADERS)

    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)

        # ⚠️ 這裡一定要驗證組出來的路徑真的落在 dist 底下。
        #
        # 少了這一步(`FRONTEND_DIST / full_path` 就直接 FileResponse)就是
        # **未經登入的任意檔案讀取**,例如:
        #     GET /../../backend/.env         → 主機設定,含管理員密碼與資料庫密碼
        #     GET /..%2f..%2fbackend%2f.env   → 同上,網址編碼一樣通
        # 等於讀得到服務帳號讀得到的任何東西,包括 ~/.claude 的憑證。
        #
        # 瀏覽器會自己把 ../ 正規化掉,所以用瀏覽器測不出來 —— 但攻擊者不用瀏覽器,
        # 原始 HTTP 請求可以送任何路徑。
        try:
            candidate = (_DIST_ROOT / full_path).resolve()
        except (OSError, ValueError):
            # Windows 上不合法的字元會在 resolve() 就丟例外
            return _index_response()

        if full_path and _DIST_ROOT in candidate.parents and candidate.is_file():
            # ⚠️ **這裡出去的檔案檔名是固定的,所以一定要標 `no-cache`。**
            #
            # 走到這條的是 dist 根目錄那幾個:`favicon.svg`、
            # `pet/*.gif`。它們**沒有**內容雜湊(有雜湊的在 /assets,走上面那個
            # mount),換了圖還是同一個網址 —— 而少了這個標頭時瀏覽器會自己「猜」
            # 一個快取時間(常見是距 Last-Modified 的 10%),換了寵物動圖之後
            # **使用者可能要等好幾天或按 Ctrl+Shift+R 才看得到**。
            #
            # `no-cache` 不是「不要快取」,是「可以存,但每次用之前要回來驗一次」——
            # 配上 FileResponse 自己帶的 ETag,沒換圖就回 304,幾乎不花流量。
            return FileResponse(candidate, headers=_REVALIDATE_HEADERS)

        # React Router 的前端路由(/c/xxx、/stats...)都交給 index.html,
        # 剩下的交給瀏覽器端路由處理。
        return _index_response()
