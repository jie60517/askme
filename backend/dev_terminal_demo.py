# -*- coding: utf-8 -*-
"""本機示範 SSH 終端機用:**一個行程**裡跑一個假的 sshd + 整套服務。

Windows 開發機沒有 sshd,又不該拿正式主機的密碼來試畫面 —— 所以這裡起一個
asyncssh 的假伺服器(跟 tests/test_terminal_bridge.py 同一套想法):

  - shell 是行編輯的回音:認得 `pwd` / `ls` / `cd` / `colors` / `exit`,其他指令回一句「這是示範用的假 shell」;
    `ls` 跟真的一樣會上色,`colors` 印一張 16 色對照表 —— 調 `ansi-palette.ts` 時對著它看;
  - **假的 `/dev/pts` 與 `/proc/<pid>/cwd`**:讓「檔案欄跟著終端機的目前目錄走」在 Windows 上
    也走得完整段(真的主機上這兩個是 Linux 給的,這裡只是照同一個形狀回答);
  - SFTP chroot 在一個暫存目錄,裡面放幾個示範檔案,拖拉上傳 / 下載 / 刪除都是真的在動它;
  - Work Flow 也開著:自己寫一份 workflow_actions.json 到暫存目錄,指令全是假的 `demo-*`(見 WORKFLOW_DEMO_ACTIONS);
  - 服務用**暫存的 SQLite**,不碰 data/app.db;
  - 管理員帳密固定(下面 ADMIN_PASSWORD),MFA 關掉 —— 只在這台機器、只給示範用。

用法(在 backend/ 底下;或 .claude/launch.json 的 `backend-demo`):
    .venv/Scripts/python dev_terminal_demo.py

然後 `npm run dev` 開前端,用 tiptop / tiptop 登入,點側邊欄 SSH Server。
⚠️ 只給本機開發用,不要部署。主機上的 SSH_TERMINAL_* 在 .env,見 deploy/env.server.example。
"""
import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
from pathlib import Path

# ── 環境要在 import app 之前設好:config.py 的 load_dotenv 不會覆蓋已存在的變數 ──
TMP = Path(tempfile.mkdtemp(prefix="t100-terminal-demo-"))
SFTP_ROOT = TMP / "home"
SSH_PORT = int(os.environ.get("DEMO_SSH_PORT", "2222"))
# 8124 而不是 8123:8123 是平常的 backend(launch.json),兩個常常同時開著。
# 前端要指過來:node frontend/dev-demo.mjs(launch.json 的 frontend-demo)。
HTTP_PORT = int(os.environ.get("PORT") or os.environ.get("DEMO_HTTP_PORT") or "8124")
ADMIN_PASSWORD = "tiptop"
SSH_PASSWORD = "demo"

os.environ.update(
    {
        "DATABASE_URL": f"sqlite:///{TMP / 'demo.db'}",
        "MFA_REQUIRED": "0",
        "ADMIN_USERNAME": "tiptop",
        "ADMIN_PASSWORD": ADMIN_PASSWORD,
        "SSH_TERMINAL_ENABLED": "1",
        "SSH_TERMINAL_HOST": "127.0.0.1",
        "SSH_TERMINAL_PORT": str(SSH_PORT),
        "SSH_TERMINAL_USER": "tiptop",
        "SSH_TERMINAL_PASSWORD": SSH_PASSWORD,
        "SSH_TERMINAL_KEY_FILE": "",
        "SSH_TERMINAL_KNOWN_HOSTS": str(TMP / "known_hosts"),
        "SSH_TERMINAL_START_DIR": "~",
        # Work Flow 的示範設定(檔案在下面 WORKFLOW_DEMO_ACTIONS 那裡寫出去)。有這個檔才會出現 Work Flow
        "WORKFLOW_ACTIONS_FILE": str(TMP / "workflow_actions.json"),
        # ⚠️ 跟 config.py 的預設值同步(0 = 閒置不斷線)。示範站自己寫一份別的值的話,
        # 示範會在真正部署不會斷的時候斷 ——
        # 要試斷線就 `DEMO_IDLE_SEC=20 python dev_terminal_demo.py`,不要改這裡的預設。
        "SSH_TERMINAL_IDLE_TIMEOUT_SEC": os.environ.get("DEMO_IDLE_SEC", "0"),
        # 主機清單上只有一台「主機」(範本只留這一台)。檔案在下面寫出去
        "TERMINAL_HOSTS_FILE": str(TMP / "terminal_hosts.json"),
    }
)

(TMP / "terminal_hosts.json").write_text(
    json.dumps(
        {
            "hosts": [
                {"id": "main", "label": "主機", "sub": "main-server · tiptop", "host": "127.0.0.1", "port": SSH_PORT,
                 "user": "tiptop", "password_env": "SSH_TERMINAL_PASSWORD", "known_hosts": str(TMP / "known_hosts")},
            ]
        },
        ensure_ascii=False,
    ),
    encoding="utf-8",
)

import asyncssh  # noqa: E402
import uvicorn  # noqa: E402


def seed_files() -> None:
    (SFTP_ROOT / "example" / "src").mkdir(parents=True)
    (SFTP_ROOT / "example" / "docs").mkdir(parents=True)
    (SFTP_ROOT / "example" / "flows").mkdir(parents=True)
    (SFTP_ROOT / "example" / "empty").mkdir(parents=True)
    (SFTP_ROOT / "example" / "src" / "orders.py").write_bytes(
        b"def main():\n    fill_orders('1=1')\n" * 400
    )
    (SFTP_ROOT / "example" / "src" / "orders_ui.py").write_bytes(b"# ui\n" * 50)
    (SFTP_ROOT / "example" / "CLAUDE.md").write_bytes("# 範例專案\n".encode("utf-8"))
    (SFTP_ROOT / "example" / "README.md").write_bytes(b"demo\n" * 30)
    (SFTP_ROOT / "example" / "flows" / "出貨流程.md").write_bytes("# 流程\n".encode("utf-8"))
    # 假的 /dev/pts:開一條 PTY 就在裡面多一格(shell() 建的),後端靠「多出來的那一格」認 tty
    (SFTP_ROOT / "dev" / "pts").mkdir(parents=True)
    (SFTP_ROOT / "notes.txt").write_bytes("hello\n".encode("utf-8"))
    (SFTP_ROOT / ".bashrc").write_bytes(b"# demo\n")


# ── 假的 Linux 零件:讓「檔案欄跟著終端機」在本機也能整段驗 ────────────────────
#: 這條假 shell 現在在哪(`/proc/<pid>/cwd` 回它)。示範只有一條連線,所以一個全域就夠。
DEMO_STATE = {"cwd": "/example", "pts": 0}
#: `ps -t pts/N -o pid=,sid=` 回的 PID。隨便一個數字,重點是 pid == sid(session leader)。
DEMO_SHELL_PID = 4242


class DemoSFTP(asyncssh.SFTPServer):
    """chroot 的 SFTP,外加一支假的 `readlink`:`/proc/<pid>/cwd` → 假 shell 的目前目錄。

    `/dev/pts` 不用假 —— 假 shell 一開就在 chroot 裡真的建一個檔案(見 `shell()`),
    後端那邊 readdir 到的就是它。
    """

    def readlink(self, path):  # noqa: D102 —— 覆寫 asyncssh 的介面
        raw = path.decode("utf-8", "replace") if isinstance(path, bytes) else path
        if raw.startswith("/proc/"):
            return DEMO_STATE["cwd"].encode()
        return super().readlink(path)


class DemoServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return username == "tiptop" and password == SSH_PASSWORD


def ansi_ls(names: list[str], base: str) -> bytes:
    """跟真的 `ls --color` 同一套上色:資料夾亮藍、markdown 青、程式碼綠、其他不上色。

    調 `frontend/src/components/terminal/ansi-palette.ts` 的時候要對著這個看 ——
    假 shell 不上色的話,配色改了也看不出差別。
    """
    out = []
    for n in names:
        if os.path.isdir(os.path.join(base, n)):
            out.append(f"\x1b[1;34m{n}\x1b[0m")
        elif n.endswith((".md", ".txt")):
            out.append(f"\x1b[36m{n}\x1b[0m")
        elif n.endswith(".py"):
            out.append(f"\x1b[32m{n}\x1b[0m")
        elif n.startswith("."):
            out.append(f"\x1b[90m{n}\x1b[0m")
        else:
            out.append(n)
    return ("  ".join(out) + "\r\n").encode()


def ansi_chart() -> bytes:
    """16 色對照表(`colors`)。"""
    rows = ["  \x1b[1m16 色 ANSI\x1b[0m(上排一般、下排亮色)\r\n".encode()]
    for base in (30, 90):
        cells = [f"\x1b[{base + i}m ██ {base + i:>3} \x1b[0m" for i in range(8)]
        rows.append(("  " + "".join(cells) + "\r\n").encode())
    rows.append("  \x1b[31m紅色的錯誤訊息\x1b[0m  \x1b[32m綠色的 OK\x1b[0m  \x1b[33m黃色的警告\x1b[0m  \x1b[1;34m藍色的資料夾\x1b[0m\r\n".encode())
    return b"".join(rows)


async def shell(process: asyncssh.SSHServerProcess) -> None:
    """行編輯的假 shell。只為了看畫面:游標、中文、換行、resize 都走得到。

    帶著命令進來的(`conn.run(...)`)當成 exec:後端找 shell PID 時會跑 `ps -t pts/N -o pid=,sid=`,
    這裡照那個格式回一行,其他命令一律空白。
    """
    command = process.command
    if command is not None:
        if isinstance(command, bytes):
            command = command.decode("utf-8", "replace")
        if "demo-" in command or (command.startswith("cd ") and command.endswith("< /dev/null")):
            # Work Flow 的假指令(WORKFLOW_DEMO_ACTIONS):撥 VPN、同步,以及「執行腳本」
            process.exit(await run_workflow_demo(command, process))
            return
        if command.startswith("ps "):
            process.stdout.write(f"{DEMO_SHELL_PID} {DEMO_SHELL_PID}\r\n".encode())
        process.exit(0)
        return

    cwd = DEMO_STATE["cwd"]
    # 開 PTY 就在(chroot 的)/dev/pts 底下多一格 —— 後端就是靠「多出來的那一格」認自己的 tty
    DEMO_STATE["pts"] += 1
    pts_file = SFTP_ROOT / "dev" / "pts" / str(DEMO_STATE["pts"])
    pts_file.parent.mkdir(parents=True, exist_ok=True)
    pts_file.write_bytes(b"")
    prompt = lambda: f"<tiptop@demo:{cwd}> ".encode()  # noqa: E731
    process.stdout.write(
        "示範用的假 shell(本機沒有 sshd)。認得 pwd / ls / cd / mkdir / rm / touch / colors / exit,其他指令只會回音。\r\n".encode()
    )
    process.stdout.write(prompt())
    line = bytearray()
    try:
        while True:
            try:
                data = await process.stdin.read(1024)
            except asyncssh.TerminalSizeChanged:
                continue
            if not data:
                break
            for b in data:
                if b in (13, 10):
                    process.stdout.write(b"\r\n")
                    cmd = line.decode("utf-8", "replace").strip()
                    line.clear()
                    if cmd == "exit":
                        process.exit(0)
                        return
                    if cmd == "pwd":
                        process.stdout.write(f"{cwd}\r\n".encode())
                    elif cmd == "ls" or cmd.startswith("ls "):
                        base = str(SFTP_ROOT) + cwd
                        try:
                            names = sorted(os.listdir(base))
                        except OSError:
                            names = []
                        process.stdout.write(ansi_ls(names, base))
                    elif cmd == "colors":
                        process.stdout.write(ansi_chart())
                    elif cmd.startswith("cd"):
                        parts = shlex.split(cmd)
                        target = parts[1] if len(parts) > 1 else "/"
                        new = target if target.startswith("/") else os.path.normpath(cwd + "/" + target)
                        new = new.replace("\\", "/")
                        if os.path.isdir(str(SFTP_ROOT) + new):
                            cwd = new if new != "." else "/"
                            # 後端每秒讀一次「/proc/<pid>/cwd」,檔案欄就是靠這個跟過來的
                            DEMO_STATE["cwd"] = cwd
                        else:
                            process.stdout.write(f"bash: cd: {target}: 沒有這個目錄\r\n".encode())
                    elif (parts := shlex.split(cmd) if cmd else []) and parts[0] in ("mkdir", "rm", "touch"):
                        # 檔案欄要自己重列:真的在 chroot 裡動,後端看到目錄的修改時間變了就推 `dir`
                        for name in (p for p in parts[1:] if not p.startswith("-")):
                            full = Path(str(SFTP_ROOT) + (name if name.startswith("/") else cwd.rstrip("/") + "/" + name))
                            try:
                                if parts[0] == "mkdir":
                                    full.mkdir(parents="-p" in parts)
                                elif parts[0] == "touch":
                                    full.touch()
                                elif full.is_dir() and ("-r" in parts or "-rf" in parts):
                                    shutil.rmtree(full)
                                elif full.is_dir():
                                    full.rmdir()
                                else:
                                    full.unlink()
                            except OSError as exc:
                                process.stdout.write(f"{parts[0]}: {name}: {exc.strerror}\r\n".encode())
                    elif cmd:
                        process.stdout.write(
                            f"demo: 這是示範用的假 shell,沒有真的執行「{cmd}」\r\n".encode()
                        )
                    process.stdout.write(prompt())
                elif b in (8, 127):
                    if line:
                        # 刪掉一個 UTF-8 字元(多位元組要整個退)
                        while line and (line[-1] & 0xC0) == 0x80:
                            line.pop()
                        if line:
                            line.pop()
                        process.stdout.write(b"\b \b")
                elif b == 3:  # Ctrl+C
                    line.clear()
                    process.stdout.write(b"^C\r\n" + prompt())
                elif b == 12:  # Ctrl+L
                    process.stdout.write(b"\x1b[2J\x1b[H" + prompt() + bytes(line))
                else:
                    line.append(b)
                    process.stdout.write(bytes([b]))
    except (asyncssh.BreakReceived, asyncssh.Error):
        pass
    finally:
        pts_file.unlink(missing_ok=True)
        process.exit(0)


# ── Work Flow 的示範 ──────────────────────────────────────────────────────────
#
# 拼圖的指令來自 workflow_actions.json;這裡寫一份指向假指令的,假 sshd 收到 `demo-*`
# 就照真的指令的樣子吐輸出(rsync 的進度列用 \r 刷新、最後印 --stats)。
# 目的地只有「客戶A」一組,主機只有「主機」一台;撥 / 斷 VPN 是一般的 vpn_up / vpn_down(假指令 demo-vpn)。
# 要看失敗那條路:同步或腳本的路徑裡帶 `/missing`(例如來源目錄填 /srv/missing),假主機就讓它失敗。
WORKFLOW_DEMO_ACTIONS = {
    "base_host": "main",
    "clients": {
        "客戶A": {
            "host": "main",
            "vpn_up": "timeout 120 demo-vpn up {client}",
            "vpn_down": "timeout 60 demo-vpn down {client}",
            "sync": "timeout 1800 demo-rsync -az {delete} --info=progress2 --stats customer-a:{src}/ {dst}/",
        },
    },
}

(TMP / "workflow_actions.json").write_text(json.dumps(WORKFLOW_DEMO_ACTIONS, ensure_ascii=False), encoding="utf-8")

DEMO_FLOW = {
    "nodes": [
        {"id": "start", "type": "start", "x": 0, "y": 176},
        {"id": "n1", "type": "vpn", "x": 150, "y": 150, "cfg": {"client": "客戶A", "retry": 1}},
        {"id": "n2", "type": "sync", "x": 440, "y": 60, "cfg": {"src": "/srv/customer-a/app", "dst": "/srv/sync/customer-a", "timeout": 30}},
        {"id": "n3", "type": "notify", "x": 440, "y": 330, "cfg": {"who": ["tiptop"]}},
        {"id": "n4", "type": "vpnoff", "x": 740, "y": 190, "cfg": {}},
    ],
    "edges": [
        {"from": "start", "out": 0, "to": "n1"},
        {"from": "n1", "out": 0, "to": "n2"},
        {"from": "n1", "out": 1, "to": "n3"},
        {"from": "n2", "out": 0, "to": "n4"},
        {"from": "n2", "out": 1, "to": "n3"},
        {"from": "n3", "out": 0, "to": "n4"},
    ],
}


async def run_workflow_demo(command: str, process: asyncssh.SSHServerProcess) -> int:
    out = lambda s: process.stdout.write(s.encode())  # noqa: E731
    fail = "/missing" in command
    if "demo-vpn up" in command:
        await asyncio.sleep(1.4)
        if fail:
            out("TLS Error: TLS key negotiation failed to occur within 30 seconds\n")
            return 1
        out("Initialization Sequence Completed\n")
        return 0
    if "demo-vpn down" in command:
        await asyncio.sleep(0.5)
        out("SIGTERM[soft,exit-with-notification] received, process exiting\n")
        return 0
    if "demo-rsync" in command:
        total, stop_at = 3960, (0.58 if fail else 1.0)
        # 真的 rsync 一開始邊列清單邊傳(ir-chk):百分比的分母一直在長、會亂跳 —— 畫面上是不定長度的動畫
        for i, (pct, seen) in enumerate(((100, 40), (82, 400), (100, 900), (91, 2100)), start=1):
            out(f"{i * 1_048_576:>14,}  {pct:>3}%   12.34MB/s    0:00:0{i} (xfr#{i * 3}, ir-chk={seen // 3}/{seen})\r")
            await asyncio.sleep(0.6)
            if "/missing-early" in command and i == 2:
                # 清單還沒收齊就斷線:拼圖上那條要整條變紅,不是消失
                out("\nrsync: connection unexpectedly closed (1,024 bytes received so far) [receiver]\nrsync error: error in rsync protocol data stream (code 12)\n")
                return 12
        for i in range(1, 25):
            frac = min(stop_at, i / 24)
            out(f"{int(224_395_264 * frac):>14,}  {int(frac * 100):>3}%   12.34MB/s    0:00:{i:02d} (xfr#{int(128 * frac)}, to-chk={int(total * (1 - frac))}/{total})\r")
            await asyncio.sleep(0.18)
            if frac >= stop_at:
                break
        if fail:
            out("\nrsync: connection unexpectedly closed (2,297 bytes received so far) [receiver]\nrsync error: error in rsync protocol data stream (code 12)\n")
            return 12
        out(f"\n\nNumber of files: {total:,} (reg: 3,712, dir: 248)\nNumber of regular files transferred: 128\nTotal transferred file size: 224,395,264 bytes\n")
        return 0
    # 「執行腳本」:引擎送的是 `cd <目錄> && <python3|bash|…> ./<檔名> < /dev/null`(workflows.SCRIPT_RUNNERS)
    if command.startswith("cd ") and " && " in command:
        await asyncio.sleep(0.6)
        if fail:
            out("No such file or directory\n")
            return 2
        out(f"(示範)執行 {command.split(' && ', 1)[1]}\nok\n")
        return 0
    out(f"demo: 不認得的指令 {command}\n")
    return 127


def seed_workflow() -> None:
    """放一條示範流程「客戶A每日同步」進暫存資料庫。"""
    from app import models, workflows
    from app.database import Base, SessionLocal, engine

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        db.add(models.Workflow(
            name="客戶A每日同步",
            graph=json.dumps(workflows.normalize_graph(DEMO_FLOW), ensure_ascii=False),
            schedule=json.dumps(workflows.normalize_schedule({"on": True, "freq": "daily", "time": "02:00"}), ensure_ascii=False),
            created_by="tiptop", updated_by="tiptop",
        ))
        db.commit()
    finally:
        db.close()


#: 用量明細(/stats/questions)的示範題目 —— 暫存資料庫沒有題目的話,那一頁在本機永遠是空的,
#: 卡片版 / 表格版都驗不到。
#: (問的人, 幾小時前, 知識庫, 問題, 成功?, 狀態, 耗時毫秒, 成本, 輪數, 每輪工具數)
DEMO_QUESTIONS = [
    ("jerry", 1, "example", "訂單結帳時運費有時算兩次,要從哪幾支程式查起?", True, "done", 48200, 0.183, 6, 3),
    ("alice", 2, "example", "付款完成後要怎麼把訂單狀態改回待付款?", True, "done", 31800, 0.094, 4, 2),
    ("ryanlee", 5, "example", "請幫我寫一段 SQL,列出上個月沒有任何訂單的客戶", False, "error", 22400, 0.061, 3, 1),
    ("alice", 7, "example", "訂單的「預計交貨日」可以批次更新嗎?", True, "done", 15100, 0.038, 2, 2),
    # ⚠️ 不放 "running":後端看到沒有真的在跑的 running 會當成已完成;也不掛 tiptop ——
    # 掛在示範帳號名下的話,側邊欄會多出一組對話,干擾其他功能的測試
    ("mia", 0, "example", "庫存月結跑完之後,單位成本異常偏高的品項要怎麼追?", True, "done", 35200, 0.101, 4, 2),
    ("jerry", 26, "example", "商品資料的「主要供應商」欄位存在哪個表?", True, "done", 9800, 0.021, 2, 1),
    ("mia", 28, "example", "簽核流程退回之後,單據狀態會變成什麼?", True, "done", 27400, 0.072, 3, 3),
    ("ryanlee", 30, "example", "這支報表要加一個「業務員」的篩選條件,要改哪裡?", True, "done", 61200, 0.241, 7, 4),
    ("alice", 49, "example", "過帳時出現 E-00123 錯誤是什麼意思?", True, "done", 18900, 0.044, 2, 2),
    ("mia", 52, "example", "幫我整理從採購到入庫的完整流程與對應程式", True, "done", 39600, 0.118, 4, 3),
    ("jerry", 73, "example", "應收帳款立帳時,如何設定自動產生分錄?", True, "done", 24300, 0.067, 3, 2),
    ("ryanlee", 75, "example", "外部系統要透過 API 寫入客戶主檔,有沒有標準的介接方式?", False, "error", 8800, 0.019, 1, 1),
]

#: 每一輪的工具呼叫(輪流取用),看起來像真的在查原始碼與資料表
_DEMO_TOOLS = [
    ("Grep", "orders.py"), ("Read", "src/orders/checkout.py"), ("Bash", "sqlite3 app.db '.schema orders'"),
    ("Read", "src/payments/refund.py"), ("Glob", "src/**/report*"), ("Read", "docs/orders.md"),
    ("Grep", "order_items"), ("Bash", "grep -rn 'E-00123' src/"),
]


def seed_questions() -> None:
    """放一批題目 + 每一步的明細進暫存資料庫,讓用量明細那頁在本機看得到東西。"""
    from datetime import datetime, timedelta

    from app import models
    from app.database import Base, SessionLocal, engine

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        tool_i = 0
        for i, (who, hours_ago, kb, question, ok, status, dur, cost, turns, tools_per_turn) in enumerate(DEMO_QUESTIONS):
            rec = models.QARecord(
                created_at=now - timedelta(hours=hours_ago, minutes=7 * i),
                session_id=f"demo-q-{i}",
                conversation_id=f"demo-conv-{i}",
                question=question,
                answer="(示範資料)" if ok else "",
                knowledge_base=kb,
                owner=who,
                asked_by=who,
                status=status,
                success=ok,
                error=None if ok else "示範用的錯誤",
                duration_ms=dur,
                cost_usd=cost,
            )
            db.add(rec)
            db.flush()
            seq = 0
            at = 0
            for t in range(turns):
                seq += 1
                at += 1500
                db.add(models.QAStep(
                    qa_record_id=rec.id, seq=seq, turn=t + 1, kind="turn", at_ms=at, model="claude-sonnet",
                    input_tokens=3000 + 900 * t, output_tokens=350 + 40 * t,
                    cache_read_tokens=12000 + 5000 * t, cache_creation_tokens=0,
                ))
                for _ in range(tools_per_turn):
                    seq += 1
                    at += 800
                    tool, target = _DEMO_TOOLS[tool_i % len(_DEMO_TOOLS)]
                    tool_i += 1
                    db.add(models.QAStep(
                        qa_record_id=rec.id, seq=seq, turn=t + 1, kind="tool", tool=tool,
                        target=target, target_full=target, at_ms=at, duration_ms=300 + 120 * (seq % 5),
                    ))
        db.commit()
    finally:
        db.close()


# ── 假的 AskME:本機的 claude CLI 多半沒登入,而那條路一報錯就看不到回答長什麼樣 ──
#
# 這一段只在這支示範腳本裡(正式部署跑真的 CLI)。它讓「回答的排版」
# ——markdown 的標題、清單、表格、行內程式碼 —— 在本機驗得到。
# **預設關**,要用就 `DEMO_FAKE_AI=1 python dev_terminal_demo.py`。
DEMO_ANSWER = """先講結論:這是一段**示範用**的回答,用來看排版對不對,不是真的分析。

### 畫面上各項的意思

| 項目 | 值 | 說明 |
|---|---|---|
| `APP_ENV` | `demo` | 執行環境 |
| `LOG_LEVEL` | `info` | 記錄層級 |

### 要做的事

1. 先確認專案目錄底下有沒有 `docs/`
2. 再跑一次 `ls -l`,看時間戳

指令自己貼(這裡不會幫你執行):

```bash
ls -l docs | head
```

不確定的地方會直說 —— 例如 `TOPALM` 從畫面上看不出用途,**不確定**。
"""


async def fake_ask(question: str, context: str):  # noqa: ANN201 —— 形狀跟 terminal_ai.ask 一樣
    """跟 `terminal_ai.ask` 同一種事件流(`delta` × N → `done`),一個字一個字吐。"""
    await asyncio.sleep(0.3)
    for chunk in DEMO_ANSWER.splitlines(keepends=True):
        yield {"type": "delta", "text": chunk}
        await asyncio.sleep(0.02)
    yield {"type": "done"}


async def main() -> None:
    seed_files()
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    (TMP / "known_hosts").write_text(
        f"[127.0.0.1]:{SSH_PORT} {host_key.export_public_key().decode().strip()}\n", encoding="utf-8"
    )
    await asyncssh.listen(
        "127.0.0.1",
        SSH_PORT,
        server_host_keys=[host_key],
        server_factory=DemoServer,
        process_factory=shell,
        sftp_factory=lambda chan: DemoSFTP(chan, chroot=str(SFTP_ROOT).encode()),
        encoding=None,
    )
    print(f"[demo] 假 sshd 在 127.0.0.1:{SSH_PORT},SFTP 根目錄 {SFTP_ROOT}", flush=True)
    print(f"[demo] 網頁登入:tiptop / {ADMIN_PASSWORD}(暫存資料庫 {TMP / 'demo.db'})", flush=True)

    # ⚠️ **預設關**:預設開的話,本機驗不到真的 CLI 那條路,
    # 而「CLI 沒裝 / 沒登入會怎樣」正是這個示範站該測得到的東西。
    # 要看回答的排版:`DEMO_FAKE_AI=1 python dev_terminal_demo.py`。
    if os.environ.get("DEMO_FAKE_AI", "0") == "1":
        from app import terminal_ai  # noqa: PLC0415 —— 只有示範模式才需要它

        terminal_ai.ask = fake_ask  # type: ignore[assignment]
        terminal_ai.available = lambda: True  # type: ignore[assignment]
        print("[demo] AskME 走假的回答(拿掉 DEMO_FAKE_AI=1 就改回真的 claude CLI)", flush=True)

    from app import auth  # noqa: PLC0415

    seed_questions()
    print(f"[demo] 用量明細:放了 {len(DEMO_QUESTIONS)} 題示範題目(含每一步明細)", flush=True)
    # Work Flow:拼圖指令換成假的、放一條示範流程。「通知人員」走真的站內通知(寫進暫存資料庫)
    seed_workflow()
    print("[demo] Work Flow:指令走 demo-*(客戶只有客戶A、主機只有一台),通知人員是站內 @(暫存資料庫)", flush=True)
    # 給自動化驗證用的 token(寫進瀏覽器 sessionStorage 的 't100_auth_token' 就是登入狀態)。
    # 只在這支示範裡:暫存資料庫、固定的示範帳號,跟真正的部署無關。
    print(f"[demo] token:{auth.issue_token('tiptop')}", flush=True)

    config = uvicorn.Config("app.main:app", host="127.0.0.1", port=HTTP_PORT, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    if sys.platform == "win32":
        # 跟 launch.json 的說明一樣:Selector loop 上 create_subprocess_exec 會 NotImplementedError,
        # 問答功能在示範裡用不到,但保險起見還是用 Proactor。
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
