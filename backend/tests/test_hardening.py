# -*- coding: utf-8 -*-
"""對外曝露面的幾道防線,各釘一條測試。

每一條都是「攻擊步驟 → 期望被擋」的形狀;拿掉對應的防線,這裡就紅。
"""
import zipfile
from datetime import datetime

from fastapi.testclient import TestClient

from app import auth, config, models, users
from app.agent import scope_readonly_tools
from app.database import Base, SessionLocal, engine
from app.extract import extract_text
from app.main import app
from app.routers.files import _safe_path
from app.security import inline_script_hashes

Base.metadata.create_all(bind=engine)


# ── 請求本文大小(security.BodySizeLimit)──────────────────────────────


def test_anonymous_request_with_big_body_is_rejected_before_routing():
    """匿名者送大 body 要在授權之前就被 413:FastAPI 是先讀 body 再驗 token。"""
    with TestClient(app) as client:
        too_big = b"q" * (config.ANON_MAX_REQUEST_KB * 1024 + 1)
        resp = client.post("/api/ask", data={"question": too_big})
    assert resp.status_code == 413


def test_anonymous_small_request_still_reaches_auth():
    """小的匿名請求照常走到路由(登入本來就是匿名的)。"""
    with TestClient(app) as client:
        resp = client.post("/api/login", json={"username": "nobody", "password": "x"})
    assert resp.status_code in (401, 429)


def test_fake_bearer_does_not_unlock_the_larger_limit():
    """憑證要真的驗:匿名者加一行 `Authorization: Bearer x` 不能拿到大的上限。"""
    with TestClient(app) as client:
        too_big = b"q" * (config.ANON_MAX_REQUEST_KB * 1024 + 1)
        resp = client.post(
            "/api/ask", data={"question": too_big}, headers={"Authorization": "Bearer not-a-token"}
        )
        assert resp.status_code == 413
        resp = client.post(
            "/api/ask", data={"question": too_big}, headers={"X-API-Key": "not-the-key"}
        )
        assert resp.status_code == 413


def test_no_default_password_means_no_new_accounts(monkeypatch):
    """.env 沒設 DEFAULT_USER_PASSWORD 就不能建帳號或重設 —— 絕不退回程式裡的字串。"""
    monkeypatch.setattr(config, "DEFAULT_USER_PASSWORD", "")
    assert users.create_user("nopw-user") is False
    monkeypatch.setattr(config, "DEFAULT_USER_PASSWORD", "changeme")  # 佔位字串也算沒設
    assert users.create_user("nopw-user") is False
    with TestClient(app) as client:
        admin = {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}
        resp = client.post("/api/users", json={"username": "nopw-user"}, headers=admin)
    assert resp.status_code == 409


def test_authenticated_request_uses_the_larger_limit():
    """帶了 token 的請求走大的那組上限,超過才 413。"""
    with TestClient(app) as client:
        token = auth._issue("someone")
        headers = {"Authorization": f"Bearer {token}"}
        ok = b"q" * (config.ANON_MAX_REQUEST_KB * 1024 + 1)  # 超過匿名上限,但遠低於登入上限
        resp = client.post("/api/ask", data={"question": ok}, headers=headers)
        assert resp.status_code != 413
        too_big = b"q" * (config.MAX_REQUEST_MB * 1024 * 1024 + 1)
        resp = client.post("/api/ask", data={"question": too_big}, headers=headers)
        assert resp.status_code == 413


# ── 回應安全標頭(security.SecurityHeaders)────────────────────────────


def test_every_response_carries_the_security_headers():
    with TestClient(app) as client:
        resp = client.get("/api/health")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["x-frame-options"] == "SAMEORIGIN"
    assert resp.headers["referrer-policy"] == "same-origin"
    # TestClient 走 http,HSTS 不該出現(http 上送了瀏覽器也會忽略)
    assert "strict-transport-security" not in resp.headers


def test_file_routes_carry_the_same_headers_as_everything_else():
    """檔案與預覽路由**沒有例外**,拿到的標頭跟其他路由一模一樣。

    ⚠️ 不要為了 PDF 預覽把這裡的標頭拿掉:同源 iframe 的 `X-Frame-Options: SAMEORIGIN`
    與 `frame-ancestors 'self'` 兩種檢查都會過。
    PDF 白掉的原因是 iframe 的 `sandbox` 屬性,修在 `FileLightbox.tsx`。

    比對的是「跟 /api/health 拿到的一樣」而不是寫死字串 —— CSP 只有在
    `frontend/dist/index.html` 存在時才送(見 security._build_csp),
    寫死的話純後端環境(沒 build 前端)會 KeyError。
    """
    with TestClient(app) as client:
        baseline = client.get("/api/health")
        for path in (
            "/api/files/deadbeef/x.pdf",
            "/api/uploads/deadbeef/x.pdf",
            "/api/preview/files/deadbeef/x.docx",
        ):
            resp = client.get(path)
            assert resp.headers["x-frame-options"] == "SAMEORIGIN", path
            assert resp.headers.get("content-security-policy") == baseline.headers.get(
                "content-security-policy"
            ), path
            assert resp.headers["x-content-type-options"] == "nosniff", path


def test_csp_hashes_match_the_inline_scripts(tmp_path):
    """index.html 的 inline script 要被算成 CSP hash,外部 script 不算。"""
    html = tmp_path / "index.html"
    html.write_text(
        '<script>console.log(1)</script><script type="module" src="/a.js"></script>',
        encoding="utf-8",
    )
    hashes = inline_script_hashes(html)
    assert len(hashes) == 1
    assert hashes[0].startswith("'sha256-") and hashes[0].endswith("'")


# ── 對話 id 的命名空間 ──────────────────────────────────────────────


def test_ask_rejects_the_workflow_namespace():
    """`workflow-<流程 id>` 是 Work Flow 通知寫結果的對話;搶先建立就能看到每次執行結果。"""
    with TestClient(app) as client:
        token = auth._issue("someone")
        resp = client.post(
            "/api/ask",
            data={"question": "hi", "conversation_id": "Workflow-7"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400


def test_workflow_followup_gets_the_run_results_as_context():
    from app.routers import ask as ask_router

    db = SessionLocal()
    try:
        conv = "workflow-ctx-test"
        db.query(models.QARecord).filter(models.QARecord.conversation_id == conv).delete()
        for i in range(4):
            db.add(models.QARecord(session_id=f"ctx-{i}", conversation_id=conv, question=f"Work Flow「x」第{i}次",
                                   answer=f"結果{i}", owner=config.WORKFLOW_OWNER, asked_by=config.WORKFLOW_OWNER))
            db.commit()
        text = ask_router._workflow_context(db, conv)
        # 最近三次、舊的在前;第 0 次太舊不帶
        assert "結果0" not in text and text.index("結果1") < text.index("結果3")
        assert text.endswith("問題:")
        db.query(models.QARecord).filter(models.QARecord.conversation_id == conv).delete()
        db.commit()
    finally:
        db.close()


def test_existing_workflow_conversation_shared_to_you_can_be_followed_up():
    """已經建好、分享給你的 Work Flow 通知對話可以續問;沒分享給你的照樣 404。
    擋的只是「還不存在的流程 id」。"""
    conv = "workflow-990001"

    def clean():
        db = SessionLocal()
        try:
            db.query(models.QARecord).filter(models.QARecord.conversation_id.in_([conv, "workflow-990002"])).delete()
            db.query(models.ConversationShare).filter(models.ConversationShare.conversation_id == conv).delete()
            db.commit()
        finally:
            db.close()

    clean()
    db = SessionLocal()
    try:
        db.add(models.QARecord(session_id="wf-990001", conversation_id=conv, question="流程結果", answer="答案",
                               owner="wf-bot", asked_by="wf-bot"))
        db.add(models.ConversationShare(conversation_id=conv, username="wf_staff", shared_by="wf-bot"))
        # 已刪除的通知對話:照樣不能被搶建回來(`owner_of` 不算已刪除的紀錄)
        db.add(models.QARecord(session_id="wf-990002", conversation_id="workflow-990002", question="q", answer="a",
                               owner="wf-bot", asked_by="wf-bot", deleted_at=datetime.utcnow()))
        db.commit()
    finally:
        db.close()
    try:
        with TestClient(app) as client:
            def ask(user, cid=conv):
                # 問題只有空白:過了 id / 權限檢查之後會在「問題是空的」那裡停下來,不會真的去問 claude
                return client.post("/api/ask", data={"question": "   ", "conversation_id": cid},
                                   headers={"Authorization": f"Bearer {auth._issue(user)}"})
            shared = ask("wf_staff")
            assert shared.status_code == 400 and "問題是空的" in shared.json()["detail"]
            assert ask("wf_stranger").status_code == 404
            assert ask("wf_staff", "workflow-990002").json()["detail"] == "conversation_id 格式不正確"
            assert ask("wf_staff", "WORKFLOW-990003").json()["detail"] == "conversation_id 格式不正確"  # 大小寫不同一樣擋
    finally:
        clean()


# ── 路徑與檔案 ───────────────────────────────────────────────────────


def test_safe_path_rejects_dot_and_empty_segments(tmp_path):
    for sid, name in ((".", "x"), ("abc", "."), ("", "x"), ("abc", ""), ("a\x00b", "x")):
        assert _safe_path(tmp_path, sid, name) is None, (sid, name)
    assert _safe_path(tmp_path, "abc", "x.txt") is not None


def test_office_zip_bomb_is_refused_without_unzipping(tmp_path):
    """central directory 宣告的解壓大小超過預算就不解析。"""
    bomb = tmp_path / "bomb.docx"
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as zf:
        # 200 MB 的零,壓完幾百 KB;宣告大小 200 MB > 單成員 128 MB 上限
        zf.writestr("word/document.xml", b"\0" * (200 * 1024 * 1024))
    assert extract_text(bomb) is None


def test_avatar_only_accepts_raster_images():
    db = SessionLocal()
    try:
        db.query(models.UserPref).filter(models.UserPref.username == "ava").delete()
        db.commit()
    finally:
        db.close()
    assert users.set_avatar("ava", "data:image/svg+xml;base64,PHN2Zz4=") is False
    assert users.set_avatar("ava", "data:image/png;base64,iVBORw0KGgo=") is True


def test_unknown_account_still_pays_for_a_hash():
    """帳號不存在也要算一次 PBKDF2,回應時間才不會變成帳號清單。"""
    import time

    t0 = time.perf_counter()
    assert users.verify("definitely-not-a-user-xyz", "whatever") is False
    elapsed = time.perf_counter() - t0
    assert elapsed > 0.05, f"不存在的帳號回得太快({elapsed:.3f}s),等於在告訴人家它不存在"


# ── 唯讀帳號的 Read/Grep/Glob 要路徑限定 ──────────────────────
#
# 為什麼是「限縮允許」而不是「追加拒絕」,寫在 agent.scope_readonly_tools 上面。
# 這裡只釘行為。
#
# ⚠️ 這些測試**不比對寫死的字串**:規則裡的路徑會先 resolve(),而同一個字面路徑
# 在 Linux 與 Windows 上 resolve 出來不一樣(開發機可能是 Windows,部署在 Linux)。
# 比對的是「規則涵蓋了哪些目錄、沒涵蓋哪些」,那才是這裡在乎的事。


def _covered_dirs(rules: str, tool: str = "Read") -> set:
    """從規則字串反推出這支工具讀得到哪些目錄(剝掉 `<工具>(//` 與 `/**)`)。"""
    prefix, suffix = f"{tool}(//", "/**)"
    return {
        rule[len(prefix) : -len(suffix)]
        for rule in rules.split(",")
        if rule.startswith(prefix) and rule.endswith(suffix)
    }


def _resolved(path) -> str:
    """同一個目錄在規則裡長什麼樣。跟 agent._abs_rule_path 的中段一致 ——
    開頭的 `/` 要剝掉,不然 Linux(/home/…)與 Windows(C:/…)對不起來。
    """
    from pathlib import Path

    return Path(path).resolve().as_posix().lstrip("/")


def test_readonly_tools_are_scoped_to_the_dirs_we_pass(tmp_path):
    """三支工具都要被收成路徑限定版,而且是雙斜線的絕對寫法。"""
    tree = tmp_path / "code"
    tree.mkdir()

    out = scope_readonly_tools("Read,Grep,Glob", [tree])

    for tool in ("Read", "Grep", "Glob"):
        assert _covered_dirs(out, tool) == {_resolved(tree)}
    # 單斜線是「專案根目錄起算」,不是檔案系統根目錄 —— 寫錯等於規則永遠比不中。
    assert all(rule.split("(", 1)[1].startswith("//") for rule in out.split(","))


def test_readonly_scoping_covers_every_readable_dir(tmp_path):
    """給幾個目錄就要涵蓋幾個,少一個就是那棵樹從此讀不到。"""
    dirs = [tmp_path / name for name in ("code", "docs", "uploads")]
    for d in dirs:
        d.mkdir()

    out = scope_readonly_tools("Read", dirs)

    assert _covered_dirs(out) == {_resolved(d) for d in dirs}


def test_scoped_rules_follow_symlinks_to_the_real_path(tmp_path):
    """規則要填 symlink 解析後的真實路徑。

    claude 會**先 realpath 再判斷權限**,填指向端比不中 —— 症狀是那棵樹整個
    讀不到,而畫面上只會看到模型說找不到檔案(config.CLAUDE_EXTRA_DIRS 上面
    已經為了同一件事交代過「要填解析後的真實路徑」)。
    """
    real = tmp_path / "real_tree"
    real.mkdir()
    link = tmp_path / "link_to_tree"
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        import pytest

        pytest.skip("這台機器不給建 symlink(Windows 要開發人員模式)")

    out = scope_readonly_tools("Read", [link])

    assert _covered_dirs(out) == {_resolved(real)}


def test_readonly_scoping_shuts_the_env_and_credentials_out(tmp_path):
    """攻擊步驟:叫它讀 .env 與 ~/.claude 憑證。兩個都不能落在範圍內。"""
    home = tmp_path / "home"
    workdir = home / "project-e"
    workdir.mkdir(parents=True)
    for secret in (home / "app" / "backend", home / ".claude", home / ".ssh"):
        secret.mkdir(parents=True)

    out = scope_readonly_tools("Read,Grep,Glob", [workdir])
    covered = _covered_dirs(out) | _covered_dirs(out, "Grep") | _covered_dirs(out, "Glob")

    for secret in (
        home / "app" / "backend",
        home / ".claude",
        home / ".ssh",
        home,
    ):
        assert _resolved(secret) not in covered
    # 最重要的一條:收完之後不能還留著一個裸的 Read —— 留著就等於什麼都沒收。
    assert all(rule.startswith(("Read(", "Grep(", "Glob(")) for rule in out.split(",")), out


def test_full_accounts_keep_their_bare_tools(tmp_path):
    """有 Bash 的那組原封不動:Bash 不吃路徑規則,收 Read 只會弄壞管理員的操作。"""
    full = config.ALLOWED_TOOLS_FULL
    assert scope_readonly_tools(full, [tmp_path]) == full
    assert scope_readonly_tools("Read,Bash(git:*)", [tmp_path]) == "Read,Bash(git:*)"


def test_bash_in_the_readonly_set_is_loud(tmp_path, caplog):
    """有人往唯讀那組加 Bash 的話,收緊會靜默失效 —— 那要叫一聲。"""
    import logging

    with caplog.at_level(logging.WARNING):
        scope_readonly_tools("Read,Grep,Glob,Bash", [tmp_path])

    assert any("路徑限定整個不生效" in r.getMessage() for r in caplog.records)


def test_no_readable_dirs_removes_the_tools_instead_of_falling_back():
    """算不出可讀目錄時要整支拿掉,**不能**悄悄退回裸規則(那是靜默把洞打開)。"""
    assert scope_readonly_tools("Read,Grep,Glob", []) == ""
    assert scope_readonly_tools("Read,WebSearch", []) == "WebSearch"


def test_followup_still_reads_the_earlier_questions_attachments(tmp_path, monkeypatch):
    """收緊之後**續問**仍要讀得到前幾題的附件。

    附件是每一題一個資料夾(session_id 是每題一個),所以第 2 題的規則只涵蓋自己
    那格 —— 不把前幾題的題號帶進 readable_dirs,使用者問「剛剛那份 PDF 第三頁
    寫什麼」就會得到「我看不到那個檔案」。
    """
    import asyncio

    from app import agent

    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "outputs")

    captured = {}

    async def fake_exec(*cmd, **kwargs):
        captured["cmd"] = list(cmd)
        raise OSError("攔下來,不真的去跑 claude CLI")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    first = "11111111-1111-1111-1111-111111111111"
    second = "22222222-2222-2222-2222-222222222222"
    other = "44444444-4444-4444-4444-444444444444"

    async def drive():
        gen = agent.stream_agent(
            question="剛剛那份 PDF 第三頁寫什麼",
            session_id=second,
            conversation_id="conv-1",
            is_new_conversation=False,
            claude_session_id="33333333-3333-3333-3333-333333333333",
            allowed_tools=config.ALLOWED_TOOLS,
            prior_session_ids=[first],
        )
        async for _ in gen:
            pass

    asyncio.run(drive())

    rules = captured["cmd"][captured["cmd"].index("--allowedTools") + 1]
    assert f"uploads/{first}/**" in rules, "續問讀不到前一題的附件"
    assert f"uploads/{second}/**" in rules, "連這一題自己的附件都讀不到"
    # 沒帶進來的題號一個都不能出現 —— 別組對話的附件不屬於這一題。
    assert other not in rules


# ── 職稱不是自由字串 ──────────────────────────────────────


def _role_in_db(username: str):
    """直接查 —— `users.get()` 刻意不回 `role`(它是給登入那條路用的)。"""
    db = SessionLocal()
    try:
        return db.get(models.User, username).role
    finally:
        db.close()


def test_patch_user_rejects_a_misspelled_role():
    """職稱打錯大小寫要當場 422,不能靜悄悄把人降成唯讀。

    `role` 若是自由字串(`Optional[str]`),送 `Software Engineer`(大寫 E)
    會通過驗證、存進資料庫,然後 `role_grants_full()` 字串比不中 → 權限沒了,
    而畫面上顯示的是一個看起來完全合理的職稱。沒有任何地方會抱怨。
    """
    users.create_user("role-typo-user")
    admin = {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}

    with TestClient(app) as client:
        bad = client.patch(
            "/api/users/role-typo-user",
            json={"role": "Software Engineer"},  # 大寫 E —— 就差這一個字母
            headers=admin,
        )
        assert bad.status_code == 422, "打錯大小寫的職稱必須被擋下來"

        # 擋下來之後資料庫要沒被動到
        assert _role_in_db("role-typo-user") != "Software Engineer"

        good = client.patch(
            "/api/users/role-typo-user",
            json={"role": users.ROLE_ENGINEER},
            headers=admin,
        )
        assert good.status_code == 200
        assert users.role_grants_full(_role_in_db("role-typo-user")) is True


def test_patch_user_still_allows_clearing_the_role():
    """空字串 = 清掉職稱,這條契約不能被 Literal 收掉。

    路由靠 `model_fields_set` 分辨「沒帶」跟「帶了空的」,清掉會存 NULL、
    讀的那側退回 DEFAULT_ROLE。網頁的下拉到不了這條路,但 API 的契約是這樣。
    """
    users.create_user("role-clear-user", role=users.ROLE_ENGINEER)
    admin = {"Authorization": f"Bearer {auth._issue(config.ADMIN_USERNAME)}"}

    with TestClient(app) as client:
        resp = client.patch(
            "/api/users/role-clear-user", json={"role": ""}, headers=admin
        )
        assert resp.status_code == 200

    assert _role_in_db("role-clear-user") in (None, "")
