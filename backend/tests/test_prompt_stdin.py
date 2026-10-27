# -*- coding: utf-8 -*-
"""問題全文不放命令列,從 stdin 交給 `claude -p`。

/proc 沒有 hidepid 的話,argv 在 `/proc/<pid>/cmdline`,同一台機器上任何帳號 `ps` 都看得到
每一題的問題(最多 20000 字)、終端機 AI 送出的遠端主機畫面。
兩條路(問答 agent、終端機 AI)都要:命令列上沒有使用者的字、stdin 收到完整的提示。

另外要守:「-259 是什麼錯誤?」這種負號開頭的問題不能被當成選項。走 stdin 的話問題根本不經過
選項解析(`printf -- '-259 …' | claude -p` 正常作答,`--append-system-prompt-file` 也有作用)。
這裡用假的 CLI 守「真的是從 stdin 送、而且一個字都沒少」。

跑法(在 backend/ 底下):
    .venv/Scripts/python -m pytest tests/test_prompt_stdin.py
"""
import asyncio
import sys

from app import agent, config, terminal_ai

QUESTION = "-259 是什麼錯誤?同事說 orders.py 存檔就跳這個"


class _Recorder:
    """假的 claude CLI 子行程:記下 argv 與 stdin,stdout 照給定的幾行吐。"""

    def __init__(self, lines=()):
        self.argv = None
        self.kwargs = None
        self.stdin_text = ""
        self.lines = list(lines)

    async def exec(self, *cmd, **kwargs):
        self.argv = list(cmd)
        self.kwargs = kwargs
        rec = self

        class Stdin:
            def write(self, data):
                rec.stdin_text += data.decode("utf-8")

            async def drain(self):
                pass

            def close(self):
                pass

        class Out:
            async def readline(self):
                await asyncio.sleep(0)
                return (rec.lines.pop(0) + "\n").encode() if rec.lines else b""

            async def read(self, _n=-1):
                return b""

        class Proc:
            returncode = 0
            stdin = Stdin()
            stdout = Out()
            stderr = Out()

            def kill(self):
                pass

            async def wait(self):
                return 0

        return Proc()


def _assert_not_on_command_line(argv, *texts):
    joined = "\n".join(argv)
    for text in texts:
        assert text not in joined, f"{text!r} 出現在命令列上"
    assert "--" not in argv, "問題走 stdin,命令列上不該有 `-- <問題>`"


def test_agent_sends_the_question_on_stdin(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "outputs")
    fake = _Recorder()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake.exec)

    async def drive():
        return [e async for e in agent.stream_agent(
            question=QUESTION,
            session_id="stdin-test",
            conversation_id="conv-stdin",
            is_new_conversation=True,
            claude_session_id="00000000-0000-4000-8000-0000000000aa",
            allowed_tools="Read,Grep,Glob",
        )]

    asyncio.run(drive())
    assert fake.kwargs["stdin"] == asyncio.subprocess.PIPE
    assert fake.stdin_text.startswith(QUESTION)
    _assert_not_on_command_line(fake.argv, "-259", "orders.py")


def test_terminal_ai_sends_question_and_screen_on_stdin(monkeypatch):
    fake = _Recorder()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake.exec)
    monkeypatch.setattr(terminal_ai, "available", lambda: True)
    screen = "deploy@app:~$ python orders.py\nERROR -259 遠端主機的畫面"

    async def drive():
        return [e async for e in terminal_ai.ask(QUESTION, screen)]

    asyncio.run(drive())
    assert fake.kwargs["stdin"] == asyncio.subprocess.PIPE
    assert QUESTION in fake.stdin_text and "遠端主機的畫面" in fake.stdin_text
    _assert_not_on_command_line(fake.argv, "-259", "orders.py", "遠端主機的畫面")


# ------------------------------------------------------------------ feed_stdin 對真的子行程
# 收到的原樣吐回來(bytes,不經過 Windows 主控台的 cp950)
_ECHO = "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"


async def _echo(text: str) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", _ECHO, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
    )
    task = agent.feed_stdin(proc, text)
    out = await asyncio.wait_for(proc.stdout.read(), 30)
    await proc.wait()
    await task
    return out


def test_feed_stdin_delivers_dash_leading_and_long_prompts():
    """負號開頭的整句原樣送到;超過 pipe 緩衝(64 KiB)的也不會卡住 —— 問題上限 20000 字,中文就是 60 KB。"""
    assert asyncio.run(_echo(QUESTION)).decode("utf-8") == QUESTION
    long = "問" * 100_000
    assert asyncio.run(_echo(long)).decode("utf-8") == long


def test_feed_stdin_does_not_blow_up_when_the_cli_exits_without_reading():
    """CLI 參數錯就馬上退出、沒讀 stdin:寫入端會 BrokenPipe,不能讓它變成一個沒人接的例外。"""

    async def run():
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import sys; sys.exit(3)", stdin=asyncio.subprocess.PIPE
        )
        await proc.wait()
        await agent.feed_stdin(proc, "x" * 1_000_000)
        return proc.returncode

    assert asyncio.run(run()) == 3
