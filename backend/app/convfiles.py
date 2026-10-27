"""把一組對話散在各處的檔案收攏成「檔案區」。

檔案是按 `session_id` 分資料夾存的,而 `session_id` 是**每一題**一個,不是每組對話
一個 —— 一組對話問了十題,檔案就散在十個資料夾。這個模組的工作就是把它們收成一份
依檔名分組、標好版次的清單。

router 只負責權限與序列化,分組與版次的規則放這裡 —— 跟 shares.py(共用)、
notes.py(便條)同一個分層。
"""

from datetime import datetime, timezone
from typing import Dict, List, Sequence

from . import config, models, schemas

# 兩種檔案分開存:使用者附上去的在 uploads/{session_id}/,claude 產出或交付的在
# outputs/{session_id}/。
_FILE_KINDS: Sequence[tuple[str, str]] = (
    ("upload", "uploaded_filename"),
    ("output", "output_files"),
)


def _base_dir(kind: str):
    return config.UPLOAD_DIR if kind == "upload" else config.OUTPUT_DIR


def group_files(
    records: Sequence[models.QARecord],
    display: Dict[str, str],
    notes: Sequence[models.ConversationNote] = (),
) -> List[schemas.ConversationFileGroup]:
    """把這組對話的所有問答**與便條**攤成檔案清單,同名的收成一組並標好版次。

    `records` 必須**由舊到新**,列舉出來的順序就是「這組對話裡的第幾題」。
    `notes` 也要由舊到新(notes_for 本來就這樣排);沒有附件的便條會被略過。
    `display` 是帳號名 → 顯示名稱,由呼叫端一次撈好傳進來(不要在迴圈裡逐筆查)。

    便條附件的錨點是「它前面那一題的題號」(turn),但 qa_id 留 None、改填 note_id
    —— 它不屬於任何一題,冒用某一題的 qa_id 的話,前端會把它算進那一題的框裡,
    點「跳到這則對話」也會跳錯地方。turn 只拿來排版次:版次是跨題照時間編的,
    便條插在第 3 題之後,它帶的「企劃書.docx」就要排在第 3 題那版後面,
    不然剛附上的會被標成舊版。

    **清單一律以資料庫欄位為準,不掃磁碟。** uploads/ 底下除了原檔案,還會有一份
    `{原檔名}.txt` —— 那是 uploads.py 對 docx/xlsx/pptx 先抽好給 claude 讀的中間產物
    (模型讀不懂二進位格式)。掃磁碟的話,使用者會在「報價單.xlsx」旁邊看到一個
    莫名其妙的「報價單.xlsx.txt」,而那根本不是他的檔案。

    磁碟只用來拿大小與實際寫出的時間,順便確認檔案還在不在。
    """
    groups: Dict[str, List[schemas.ConversationFileVersion]] = {}
    seen: set = set()

    for turn, record in enumerate(records, start=1):
        for kind, column in _FILE_KINDS:
            for name in (getattr(record, column) or "").split(","):
                name = name.strip()
                # 這兩個欄位是我們自己寫的(檔名在 uploads.py 就過濾過了),但同一個
                # 檔名等一下會被拿去組下載網址。真有奇怪的東西混進來時,這裡不列出來
                # 比列一個點下去必定 400 的連結乾淨 —— files.py 那邊照樣會擋。
                if not name or ".." in name or "/" in name or "\\" in name:
                    continue
                # 同一題的 uploaded_filename 有可能出現重複的檔名(一次附了兩個同名檔,
                # 後者覆蓋前者,但欄位裡留了兩筆)。磁碟上只有一個,清單也只該有一個。
                key = (kind, record.session_id, name)
                if key in seen:
                    continue
                seen.add(key)

                try:
                    stat = (_base_dir(kind) / record.session_id / name).stat()
                except OSError:
                    stat = None

                who = record.asked_by or record.owner
                groups.setdefault(name, []).append(
                    schemas.ConversationFileVersion(
                        kind=kind,
                        session_id=record.session_id,
                        size=stat.st_size if stat else None,
                        created_at=_written_at(stat, record.created_at),
                        qa_id=record.id,
                        turn=turn,
                        question=record.question,
                        asked_by=(display.get(who, who) if who else None),
                        version=0,  # 排序完才編得出來,見 _numbered
                        missing=stat is None,
                    )
                )

    # 便條的附件。iterate 順序要在問答之後:同一個 turn 錨點上,sort 是穩定的,
    # 先插的(那一題自己的檔案)排前面、便條的排後面 —— 這正是時間順序。
    asked_ats = [r.created_at for r in records]
    for note in notes:
        if not note.attachment_sid:
            continue
        # 這則便條落在第幾題之後(0 = 還沒有任何一題,理論上不會發生 ——
        # 便條要先問過一題才寫得成,但時鐘飄移不值得炸掉整份清單)
        anchor = sum(1 for at in asked_ats if at <= note.created_at)
        for name in (note.attachments or "").split(","):
            name = name.strip()
            if not name or ".." in name or "/" in name or "\\" in name:
                continue
            try:
                stat = (config.UPLOAD_DIR / note.attachment_sid / name).stat()
            except OSError:
                stat = None
            groups.setdefault(name, []).append(
                schemas.ConversationFileVersion(
                    kind="upload",
                    session_id=note.attachment_sid,
                    size=stat.st_size if stat else None,
                    created_at=_written_at(stat, note.created_at),
                    qa_id=None,
                    note_id=note.id,
                    turn=anchor,
                    question=note.body,
                    asked_by=display.get(note.author, note.author),
                    version=0,
                    missing=stat is None,
                )
            )

    return _numbered(groups)


def _written_at(stat, asked_at: datetime) -> datetime:
    """這個檔案要顯示的時間。

    優先用檔案實際寫出的時間,而不是問題送出的時間 —— 一題跑十幾分鐘是常態,
    產出的檔案標成「開始問的時間」會對不上使用者的記憶。

    ⚠️ **但 mtime 有可能比問題還早,那時要用問題的時間。** 交付「主機上已經存在的
    檔案」走的是 `agent.apply_copy_manifest`,它用 `shutil.copy2` —— 而 copy2
    **會連來源的 mtime 一起複製**。claude 今天交付一支 2024 年的 service.py,
    它的 mtime 就是 2024 年;照那個顯示會變成「這份是兩年前的」,而它其實是剛拿到的。

    ⚠️ 一定要轉成 **naive UTC**,跟 `created_at` 用的 `utcnow()` 對齊。直接寫
    `datetime.fromtimestamp(...)` 拿到的是主機本地時間,而它序列化出去一樣沒有時區
    標記 —— 前端的 `parseServerTime` 會替所有裸時間補上 Z 當成 UTC,主機時區是
    UTC+8 的話檔案時間就整整多出八小時。
    """
    if stat is None:
        return asked_at
    written = datetime.fromtimestamp(stat.st_mtime, timezone.utc).replace(tzinfo=None)
    return written if written >= asked_at else asked_at


def _numbered(
    groups: Dict[str, List[schemas.ConversationFileVersion]]
) -> List[schemas.ConversationFileGroup]:
    """替每組同名檔案編版次,並讓 `versions[0]` 一定是目前版本。

    版次**跨 upload/output 一起編**,不分開:使用者上傳「企劃書.docx」、叫 AI 改一版
    再產出同名檔案,對他而言那就是同一份東西的兩版 —— 分開編的話清單上會同時出現
    兩個「目前版本」,而那正是這個功能要消滅的困惑。
    """
    result: List[schemas.ConversationFileGroup] = []
    for name, versions in groups.items():
        # ⚠️ **照 turn 排,不要照 created_at 排。** turn 是這組對話裡的第幾題,
        # 一定是遞增的;檔案時間不是 —— `apply_copy_manifest` 用 shutil.copy2 交付
        # 主機上既有的檔案時會保留來源的 mtime,今天交付的 service.py 可能標著 2024 年。
        # 照時間排的話,那份剛拿到的會被排成 v1「舊版本」收進摺疊,而幾個月前上傳的
        # 舊檔反而掛上「目前版本」—— 正好是這個功能要防的那件事。
        #
        # sort 是穩定的,所以同一題裡的先後(upload 先於 output)會照插入順序保留。
        versions.sort(key=lambda v: v.turn)
        for index, version in enumerate(versions, start=1):
            version.version = index
        versions.reverse()  # versions[0] 一定是目前版本,舊版排在後面
        result.append(schemas.ConversationFileGroup(name=name, versions=versions))

    # 最近有動靜的排前面,同樣照題號而不是檔案時間。qa_id 是穩定的第二順位 ——
    # 同一題一次產出好幾個檔案時 turn 相同,少了它排序每次都可能不一樣,
    # 畫面上的檔案會莫名跳位。便條附件的 qa_id 是 None(用 note_id 補位),
    # `or 0` 是因為 None 跟 int 比大小會直接 TypeError。
    result.sort(
        key=lambda g: (
            g.versions[0].turn,
            g.versions[0].qa_id or 0,
            g.versions[0].note_id or 0,
        ),
        reverse=True,
    )
    return result
