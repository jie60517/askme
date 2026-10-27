"""容器的進入點:讀 askme.env → 準備資料目錄 → 換成要跑的指令(預設 uvicorn)。

為什麼不用 compose 的 `env_file:`
    compose 會對沒加引號與雙引號的值展開 `$VAR` / `${VAR}`。密碼裡只要有 `$`,
    就會悄悄變成另一個值 —— 登入失敗,畫面上看不出原因。這裡用 python-dotenv 並關掉
    展開,檔案裡寫什麼就是什麼。

優先順序
    已經在環境裡的值優先(compose 的 `environment:`),askme.env 只補沒設的。
    所以 DATABASE_URL 這幾個由 compose 給的,askme.env 裡寫了也不會生效。
"""
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path("/run/askme/askme.env")
UVICORN = [
    "uvicorn", "app.main:app",
    "--host", "0.0.0.0", "--port", "8100",
    # SSH 終端機的 WebSocket 訊息上限(1 MiB)
    "--ws-max-size", "1048576",
]


def die(msg: str) -> None:
    print(f"[entrypoint] {msg}", file=sys.stderr, flush=True)
    sys.exit(2)


def load_env() -> None:
    if not ENV_FILE.is_file():
        what = "是一個目錄" if ENV_FILE.is_dir() else "不存在"
        die(
            f"{ENV_FILE} {what} —— 部署資料夾裡沒有 askme.env。\n"
            "  從範本複製一份再啟動:cp askme.env.example askme.env\n"
            "  (若部署資料夾裡多出一個叫 askme.env 的空資料夾,是 docker 替你建的,先刪掉它)"
        )
    for key, value in dotenv_values(ENV_FILE, interpolate=False).items():
        if value is not None:
            os.environ.setdefault(key, value)


def check_config() -> None:
    kb = os.environ.get("KNOWLEDGE_BASES_FILE", "")
    if kb and not Path(kb).is_file():
        die(
            f"{kb} 不存在 —— 部署資料夾裡沒有 knowledge_bases.json。\n"
            "  從範本複製一份再啟動:cp knowledge_bases.example.json knowledge_bases.json"
        )


def choose_claude_auth() -> None:
    """claude 用哪一種登入(.env 的 CLAUDE_AUTH,compose 帶進來)。

    subscription  claude 用自己存在 ~/.claude 的訂閱登入(第一次要 `claude` → /login)。
    apikey        走 keyproxy:base URL 指過去,key 是假值,真的 key 只在 keyproxy 容器。

    這兩個變數**只在這裡設**,不寫在 compose 的 environment —— 寫在那邊的話
    `docker compose exec askme claude`(登入訂閱)也會帶著假 key,登入就亂了;
    -p 模式下有 key 也一定先用 key,登入的訂閱完全用不到。
    """
    mode = (os.environ.get("CLAUDE_AUTH") or "subscription").strip().lower()
    if mode == "apikey":
        os.environ["ANTHROPIC_BASE_URL"] = "http://keyproxy:8080"
        os.environ["ANTHROPIC_API_KEY"] = "placeholder-real-key-lives-in-keyproxy"
    elif mode == "subscription":
        os.environ.pop("ANTHROPIC_BASE_URL", None)
        os.environ.pop("ANTHROPIC_API_KEY", None)
    else:
        die(f"CLAUDE_AUTH={mode!r} 不認得,只能是 subscription 或 apikey(在 .env 改)")


def prepare_data() -> None:
    # 上傳檔與 AI 產出放在 volume askme-data 裡;第一次啟動時建好兩個子目錄
    root = os.environ.get("AGENT_KNOWLEDGE_DIR")
    if root:
        for sub in ("uploads", "outputs"):
            Path(root, sub).mkdir(parents=True, exist_ok=True)


def main() -> None:
    load_env()
    check_config()
    choose_claude_auth()
    prepare_data()
    cmd = sys.argv[1:] or UVICORN
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
