from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from .. import auth, config, convfiles, ids, models, notes, runs, schemas, shares, users
from ..conv_title import summarize_title
from ..database import chunked, get_db

router = APIRouter(prefix="/api", tags=["conversations"])

# path 參數的字元與長度限制。規則的唯一來源在 ids.py —— conversation_id 與帳號名
# 用的是同一組,而它同時也是 ask.py 與 CreateUserRequest 在用的那一組。
_CONV_ID = ids.path_param()
_USERNAME = ids.path_param()


def visible_to(query, db: Session, viewer: str):
    """把查詢限制在這個人看得到的範圍:**自己的 + 別人分享給他的**。

    這個函式是整個隔離的唯一出入口,每一條會讀到 QARecord 的路徑都要經過它 ——
    漏掉任何一條,那條路徑就等於沒有隔離。

    ⚠️ 「看得到」不等於「可以刪」。刪除與管理共用對象是 owner 專屬,那些路徑
    要另外用 shares.owner_of 判斷,不能只靠這個函式(見 delete_conversation)。

    viewer 一律是 require_user 給的登入身分。

    ⚠️ owner 是 NULL 的紀錄沒有任何帳號看得到。

    ⚠️ **已刪除的紀錄一律濾掉。** 刪對話走的是軟刪除(見 models.QARecord.deleted_at
    —— 為了讓管理員的用量統計不會因為使用者刪對話而缺一塊),所以那些列
    **還在資料表裡**。這個過濾條件是「刪掉的東西真的看不到」的唯一保證:
    這裡漏掉的話,被刪的對話會原封不動回到側邊欄,而使用者以為它不見了。
    """
    query = query.filter(models.QARecord.deleted_at.is_(None))
    shared_ids = shares.shared_with(db, viewer)
    if not shared_ids:
        return query.filter(models.QARecord.owner == viewer)
    return query.filter(
        or_(
            models.QARecord.owner == viewer,
            models.QARecord.conversation_id.in_(shared_ids),
        )
    )


@router.get("/conversations", response_model=List[schemas.ConversationSummary])
def list_conversations(
    db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)
):
    # 直接在 Python 端依 conversation_id 分組最簡單也最不容易出錯,
    # 不用刻意在 SQL 裡湊「每組第一句話」這種聚合。
    #
    # ⚠️ **只撈下面真的會用到的欄位**:這條每 8 秒輪詢一次(前端 sharedWatch.ts),
    # 整列載入等於每一輪都把這個人**全部問答的 answer 全文**讀進來,而回應裡
    # 一個 answer 字元都用不到。question 也不在這裡撈:
    # 它只拿來算「沒改過名的那組」第一題的標題,下面另外只撈那幾題。
    # 加欄位之前先確認回應真的需要,不要改回 db.query(models.QARecord)。
    records = (
        visible_to(
            db.query(
                models.QARecord.id,
                models.QARecord.conversation_id,
                models.QARecord.created_at,
                models.QARecord.status,
                models.QARecord.owner,
            ),
            db,
            viewer,
        )
        .order_by(models.QARecord.created_at.asc())
        .all()
    )

    grouped: dict[str, list] = {}
    for r in records:
        key = r.conversation_id or f"single-{r.id}"
        grouped.setdefault(key, []).append(r)

    # 自訂標題只撈**這個人看得到的那幾組**,不是全站的 conversation_meta
    # (整張表載進來的話,量跟著全站的對話數長)。分批是因為 SQLite 的
    # IN (...) 有變數上限,理由見 database.chunked。
    # single-* 是上面自己編的鍵,meta / 便條 / 共用裡都不會有 —— 不帶進去,
    # 每 8 秒的輪詢才不會多送一堆一定查不到的參數。
    conv_keys = [k for k in grouped if not k.startswith("single-")]
    custom_titles: dict[str, str] = {}
    for batch in chunked(conv_keys):
        for conv_id, custom_title in (
            db.query(models.ConversationMeta.conversation_id, models.ConversationMeta.custom_title)
            .filter(models.ConversationMeta.conversation_id.in_(batch))
            .all()
        ):
            if custom_title:
                custom_titles[conv_id] = custom_title

    # 沒改過名的那幾組才需要第一題的原文(給 summarize_title 算標題)
    first_questions: dict[int, str] = {}
    need_question = [recs[0].id for key, recs in grouped.items() if key not in custom_titles]
    for batch in chunked(need_question):
        for rec_id, question in (
            db.query(models.QARecord.id, models.QARecord.question)
            .filter(models.QARecord.id.in_(batch))
            .all()
        ):
            first_questions[rec_id] = question

    # 每組對話最後一則便條的時間。
    #
    # 便條要算進 updated_at,不然「有人 @ 我」對前端而言是完全沒有動靜的 ——
    # 側邊欄的輪詢比對的就是這個值,不動的話共用的同事要自己重新整理才看得到那則便條,
    # 而問答是即時的,只有便條不是,那看起來就像壞掉。
    last_note: dict[str, "datetime"] = {}
    # ⚠️ 分批:一組 IN 塞全部對話的話,對話多到幾萬組會撞 SQLite 的變數上限
    for batch in chunked(conv_keys):
        for conv_id, at in (
            db.query(
                models.ConversationNote.conversation_id,
                func.max(models.ConversationNote.created_at),
            )
            .filter(models.ConversationNote.conversation_id.in_(batch))
            .group_by(models.ConversationNote.conversation_id)
            .all()
        ):
            last_note[conv_id] = at

    # 每組對話還有幾則 @ 我沒讀的。掛在對話清單上,使用者才知道該點哪一組
    unread = notes.unread_by_conversation(db, viewer)

    # 一次撈完共用關係,不要在迴圈裡逐組查 —— 那會變成 N 次查詢
    incoming = {
        row.conversation_id: row.shared_by
        for row in db.query(models.ConversationShare)
        .filter(models.ConversationShare.username == viewer)
        .all()
    }
    # 這裡撈整列而不是只撈 conversation_id:同一趟就能組出每組對話的共用成員,
    # 給側邊欄共用 icon 的 hover 用 —— 不要為了名單再開一條 API 讓前端逐組查。
    recipients_by_conv: dict[str, list[str]] = {}
    for batch in chunked(conv_keys):
        for row in (
            db.query(models.ConversationShare)
            .filter(models.ConversationShare.conversation_id.in_(batch))
            .all()
        ):
            recipients_by_conv.setdefault(row.conversation_id, []).append(row.username)
    outgoing = set(recipients_by_conv.keys())

    display = users.display_names()

    def share_members(conv_id: str, recs: list) -> list[str]:
        """共用成員的顯示名稱,擁有者排第一。沒在共用的回空清單。"""
        if conv_id not in outgoing and conv_id not in incoming:
            return []
        names: list[str] = []
        owner = recs[0].owner
        if owner:
            names.append(display.get(owner, owner))
        for username in recipients_by_conv.get(conv_id, ()):
            name = display.get(username, username)
            if name not in names:
                names.append(name)
        return names

    summaries = [
        schemas.ConversationSummary(
            conversation_id=conv_id,
            # 沒改過名就用第一則問題的重點(不是原文,見 conv_title)
            title=custom_titles.get(conv_id)
            or summarize_title(first_questions.get(recs[0].id, "")),
            created_at=recs[0].created_at,
            # 問答與便條取比較晚的那個 —— 見上面 last_note 的說明
            updated_at=max(recs[-1].created_at, last_note.get(conv_id, recs[-1].created_at)),
            turn_count=len(recs),
            running=any(r.status == "running" for r in recs),
            # 別人分享給我的 —— 側邊欄要歸到「共用」那一區
            shared_with_me=conv_id in incoming,
            shared_by=incoming.get(conv_id),
            # 我自己的、而且已經分享出去了。用 owner 判斷而不是「不在 incoming 裡」,
            # 因為兩者可以同時成立(A 分享給我、我又轉分享給 B)—— 那時它對我而言
            # 仍然是「別人分享給我的」,不該被當成我分享出去的。
            shared_out=conv_id not in incoming and conv_id in outgoing,
            unread_mentions=unread.get(conv_id, 0),
            share_members=share_members(conv_id, recs),
        )
        for conv_id, recs in grouped.items()
    ]
    summaries.sort(key=lambda c: c.updated_at, reverse=True)
    return summaries


# 這條一定要宣告在 /conversations/{conversation_id} 前面 ——
# FastAPI 照宣告順序比對,反過來的話 "search" 會被當成一個 conversation_id。
@router.get("/conversations/search", response_model=List[schemas.ConversationSearchHit])
def search_conversations(
    q: str, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)
):
    """在問題**與答案**裡找關鍵字。

    只比對標題是不夠的:標題就是對話的第一句話,而關鍵字多半落在答案裡,
    或落在第二題以後。
    """
    keyword = q.strip()
    if len(keyword) < 2:
        return []

    # SQLite 的 LIKE 對 ASCII 才會忽略大小寫,中文本來就沒有大小寫問題;
    # 資料量是幾千筆等級,不用為了這個把 FTS5 搬進來。
    pattern = f"%{keyword}%"
    records = (
        visible_to(db.query(models.QARecord), db, viewer)
        .filter(
            or_(
                models.QARecord.question.ilike(pattern),
                models.QARecord.answer.ilike(pattern),
            )
        )
        # Work Flow 的「這次的結果」對話頁不畫,搜到它點進去卻看不到命中的字 —— 不搜。
        # 跟 config.is_workflow_result 同一條規則(這裡是它的 SQL 寫法,改一邊要改另一邊)
        .filter(
            ~and_(
                models.QARecord.owner == config.WORKFLOW_OWNER,
                func.coalesce(models.QARecord.asked_by, models.QARecord.owner) == config.WORKFLOW_OWNER,
            )
        )
        .order_by(models.QARecord.created_at.desc())
        .limit(200)
        .all()
    )

    custom_titles = {
        m.conversation_id: m.custom_title
        for m in db.query(models.ConversationMeta).all()
        if m.custom_title
    }

    # 同一組對話只留最新的一筆命中,不然搜一個常見詞會被同一組對話洗版
    matched: List[models.QARecord] = []
    seen: set = set()
    for record in records:
        conv_id = record.conversation_id or f"single-{record.id}"
        if conv_id in seen:
            continue
        seen.add(conv_id)
        matched.append(record)
        if len(matched) >= 30:
            break

    # 標題要用「這組對話的第一句話」,不能用命中的那一則問題 ——
    # 不然同一組對話在側邊欄清單跟搜尋結果會顯示成兩個不同的名字。
    conv_ids = [r.conversation_id for r in matched if r.conversation_id]
    first_questions: dict = {}
    if conv_ids:
        for cid, question in (
            visible_to(
                db.query(models.QARecord.conversation_id, models.QARecord.question),
                db,
                viewer,
            )
            .filter(models.QARecord.conversation_id.in_(conv_ids))
            .order_by(models.QARecord.created_at.asc())
            .all()
        ):
            first_questions.setdefault(cid, question)

    hits: List[schemas.ConversationSearchHit] = []
    for record in matched:
        conv_id = record.conversation_id or f"single-{record.id}"
        matched_in = "question" if keyword.lower() in record.question.lower() else "answer"
        source_text = record.question if matched_in == "question" else record.answer
        hits.append(
            schemas.ConversationSearchHit(
                conversation_id=conv_id,
                title=custom_titles.get(conv_id)
                or summarize_title(first_questions.get(record.conversation_id) or record.question),
                updated_at=record.created_at,
                snippet=_snippet(source_text, keyword),
                matched_in=matched_in,
            )
        )
    return hits


_SNIPPET_PAD = 50


def _snippet(text: str, keyword: str) -> str:
    """截出關鍵字前後各一小段。找不到就退回開頭那一段,不要回空字串。"""
    flat = " ".join(text.split())
    index = flat.lower().find(keyword.lower())
    if index < 0:
        return flat[: _SNIPPET_PAD * 2] + ("..." if len(flat) > _SNIPPET_PAD * 2 else "")
    start = max(0, index - _SNIPPET_PAD)
    end = min(len(flat), index + len(keyword) + _SNIPPET_PAD)
    return ("..." if start > 0 else "") + flat[start:end] + ("..." if end < len(flat) else "")


def _visible_records(db: Session, conversation_id: str, viewer: str):
    """這個人看得到的、屬於這組對話的所有問答。看不到就回空的。

    看不到跟不存在都回 404(而不是 403)—— 回 403 等於告訴對方
    「這組對話存在,只是不給你看」。
    """
    return (
        visible_to(db.query(models.QARecord), db, viewer)
        .filter(models.QARecord.conversation_id == conversation_id)
        .order_by(models.QARecord.created_at.asc())
        .all()
    )


@router.get("/conversations/{conversation_id}", response_model=List[schemas.HistoryItem])
def get_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    records = _visible_records(db, conversation_id, viewer)
    if not records:
        raise HTTPException(status_code=404, detail="找不到這個對話")

    # 補上「這一題是誰問的」。asked_by 是 NULL 的紀錄退回用 owner
    # (跟檔案區 convfiles 同一條退路)。
    # 顯示名稱一次查完再逐筆填,不要在迴圈裡查 users 表。
    display = users.display_names()
    items: List[schemas.HistoryItem] = []
    for record in records:
        item = schemas.HistoryItem.model_validate(record)
        who = record.asked_by or record.owner
        item.asked_by = who
        item.asked_by_name = display.get(who, who) if who else None
        item.is_workflow_result = config.is_workflow_result(record.owner, record.asked_by)
        items.append(item)
    return items


# ---------------------------------------------------------------- 檔案區


@router.get(
    "/conversations/{conversation_id}/files",
    response_model=List[schemas.ConversationFileGroup],
)
def list_conversation_files(
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """這組對話裡所有上傳與產出的檔案(含便條的附件),同名的收成一組並標好版次。

    分組與版次的規則在 `convfiles.py`,這裡只負責權限與序列化。

    權限走 _visible_records,所以**共用的同事看到的跟原作者完全一樣** ——
    因為這份清單是照 conversation_id 查的,不是照 owner 查的。同事上傳的附件、
    同事叫 AI 產出的檔案、@ 人時夾的檔案,三種都會看到,不需要另外同步什麼。
    """
    records = _visible_records(db, conversation_id, viewer)
    if not records:
        raise HTTPException(status_code=404, detail="找不到這個對話")
    return convfiles.group_files(
        records, users.display_names(), notes.notes_for(db, conversation_id)
    )


@router.patch("/conversations/{conversation_id}", response_model=schemas.ConversationSummary)
def rename_conversation(
    conversation_id: str,
    req: schemas.RenameConversationRequest,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    # 共用者也能改名,**跟刪除的界線刻意不同**:刪除會毀掉別人的東西,改名不會,
    # 而共用對話本來就是一起用的,原作者隨時可以改回來。
    records = _visible_records(db, conversation_id, viewer)
    if not records:
        raise HTTPException(status_code=404, detail="找不到這個對話")

    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="標題不能是空的")

    meta = db.get(models.ConversationMeta, conversation_id)
    if meta is None:
        meta = models.ConversationMeta(conversation_id=conversation_id, custom_title=title)
        db.add(meta)
    else:
        meta.custom_title = title
    db.commit()

    return schemas.ConversationSummary(
        conversation_id=conversation_id,
        title=title,
        created_at=records[0].created_at,
        updated_at=records[-1].created_at,
        turn_count=len(records),
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    # 先確認這個人真的看得到這組對話 —— 少了這一步,知道網址的人可以刪掉
    # 別人的對話,而且被刪的人完全不會知道發生什麼事。
    #
    # 但「看不到」不回 404,直接當成功:這條路徑的語意是「把它從我的清單移掉」,
    # 而它已經不在我的清單裡了 —— 目的達成,沒有東西壞掉。
    #
    # 例如 A 把共用取消了,B 的側邊欄還是舊的(共用清單 8 秒才輪詢一次),
    # B 按下「離開共用」—— 回 404 的話畫面會跳「刪除失敗」,而那一列還賴在原地。
    #
    # 順帶把殘留的共用列清掉(對話已經被原作者刪光、共用列卻還在的情況),
    # 不然 B 的側邊欄會一直出現一組點進去 404 的幽靈對話。
    if not _visible_records(db, conversation_id, viewer):
        shares.remove(db, conversation_id, viewer)
        # 他的提及也一起清 —— 留著的話輪詢還會把便條送給他,未讀數也會掛在
        # 一組他點進去只會 404 的對話上(見 notes.remove_for_user)
        notes.remove_for_user(db, conversation_id, viewer)
        return

    # ⚠️ 看得到 ≠ 可以刪。被分享的人按「刪除」時,合理的期待是「從我的清單移掉」,
    # 不是「把原作者的對話毀掉」。所以這裡只解除他自己的共用,原始資料不動。
    #
    # 少了這個分支的話只有兩種下場,兩種都不好:回 404(他明明看得到,會覺得壞了),
    # 或真的刪掉(別人的東西沒了,而且原作者完全不知道發生什麼事)。
    if shares.owner_of(db, conversation_id) != viewer:
        shares.remove(db, conversation_id, viewer)
        # 他的提及也一起清 —— 留著的話輪詢還會把便條送給他,未讀數也會掛在
        # 一組他點進去只會 404 的對話上(見 notes.remove_for_user)
        notes.remove_for_user(db, conversation_id, viewer)
        return

    # 這組對話還有題目在跑的話先把它停掉,不然 claude 會繼續空跑到結束
    # (跑完要寫回的那筆紀錄已經被刪了),白白佔著名額也白花錢。
    active = runs.active_for_conversation(conversation_id)
    if active is not None:
        active.request_stop()

    # **軟刪除,而且把內容清空。** 兩件事要一起做,少了任何一半都不對:
    #
    #   標記 `deleted_at` —— 這一列要留下來,不然管理員的用量統計會跟著少一塊
    #     (成本、token、誰問的全部消失,而且沒有任何線索)。詳細理由見
    #     models.QARecord.deleted_at。
    #   清空內容 —— 使用者按刪除要的是「這些字不見了」。只標記不清空的話,
    #     那等於偷偷把他的問答留了下來,而畫面上告訴他已經刪掉了。
    #
    # 留下來的只有數字與身分:誰、什麼時候、跑了幾輪、花了多少。統計要的就是
    # 這些,而它們本來就不是使用者按下刪除時想抹掉的東西。
    #
    # `question` / `answer` 是 NOT NULL,所以清成空字串而不是 NULL。
    # 前端不會讀到它們(visible_to 已經濾掉整列),統計頁則靠 `deleted_at`
    # 顯示成「已刪除」而不是一題空白的問題。
    #
    # ⚠️ **流水帳(`qa_steps`)也要清,而且很容易漏。** 軟刪除不會觸發
    # `ON DELETE CASCADE`,那些列會留下來 ——
    # 而管理員的題目明細頁照樣把它們送出來。裡面是**檔案路徑、搜尋字串、
    # 完整的 Bash 指令**,對一筆標著「已刪除」的紀錄來說,那比問題原文還敏感。
    #
    # 留的是數字(token、耗時、第幾輪),清的是標的(碰了什麼)。
    record_ids = [
        row[0]
        for row in visible_to(db.query(models.QARecord.id), db, viewer)
        .filter(models.QARecord.conversation_id == conversation_id)
        .all()
    ]
    if not record_ids:
        raise HTTPException(status_code=404, detail="找不到這個對話")

    for chunk in chunked(record_ids):
        db.query(models.QAStep).filter(models.QAStep.qa_record_id.in_(chunk)).update(
            {
                models.QAStep.target: None,
                models.QAStep.target_full: None,
                models.QAStep.detail: None,
            },
            synchronize_session=False,
        )

    db.query(models.QARecord).filter(models.QARecord.id.in_(record_ids)).update(
        {
            models.QARecord.deleted_at: datetime.utcnow(),
            models.QARecord.question: "",
            models.QARecord.answer: "",
            models.QARecord.sources: None,
            models.QARecord.error: None,
            models.QARecord.uploaded_filename: None,
            models.QARecord.output_files: None,
        },
        synchronize_session=False,
    )

    meta = db.get(models.ConversationMeta, conversation_id)
    if meta is not None:
        db.delete(meta)
    db.commit()

    # 對話沒了,共用紀錄也要清掉 —— 留著的話那些人的側邊欄會出現一組
    # 點進去 404 的幽靈對話
    shares.remove_all(db, conversation_id)
    # 便條與還沒通報的提及同理:留著的話對方的小夥伴會跳出一則點下去 404 的訊息
    notes.remove_all(db, conversation_id)


# ---------------------------------------------------------------- 共用

@router.get("/shareable-users", response_model=List[schemas.ShareablePerson])
def shareable_users(viewer: str = Depends(auth.require_user)):
    """可以分享的對象清單。給「分享給誰」那個選單用。

    帳號、顯示名稱、一個給畫面用的職稱(@ 選單的副標),以及**頭像**。
    頭像不是只有這個選單在用 —— 前端把這條的結果當成全站唯一的一份名冊
    (`lib/peopleDirectory.ts`),側邊欄的共用名單與對話裡的同事頭像都讀它。
    密碼狀態、建立時間那些一律不給 —— 這條是**一般帳號**也能打的(不然沒有人能分享)。
    職稱是資料庫的 `users.role`(它就是權限,取捨見 schemas.ShareablePerson)。

    排除自己(分享給自己沒有意義)與停用的帳號(他登不進來,分享了也看不到)。
    """
    return [
        schemas.ShareablePerson(
            username=u["username"],
            display_name=u["display_name"],
            role=u["role"],
            # ⚠️ **不要漏掉頭像**。這一欄是 `peopleDirectory` 唯一的來源,
            # 而側邊欄的共用名單、@ 選單、對話裡的同事頭像全都走那份名冊 ——
            # 漏掉的話每個人都設了照片,畫面上卻一律是名字縮寫,
            # 而且看起來像是「頭像沒存進去」(其實存了,只是沒發出來)。
            avatar=u["avatar"],
        )
        for u in users.list_active()
        if u["username"] != viewer
    ]


@router.post("/conversations/{conversation_id}/share", response_model=List[schemas.ShareEntry])
def share_conversation(
    req: schemas.ShareRequest,
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """把對話分享給指定的帳號。

    **看得到的人都能再分享出去**(原作者與已被分享的人皆可)。這是刻意放寬的:
    共用對話的用途就是把懂的人拉進來,而知道該找誰的往往不是原作者。

    代價是原作者可能在不知情的狀況下多出幾個讀者。用 shared_by 記下是誰拉進來的,
    共用清單上看得到 —— 追得出來比擋住更符合這裡的實際用法。
    """
    if not shares.can_access(db, conversation_id, viewer):
        # 看不到就當作不存在,不要回 403 —— 回 403 等於確認「這組對話存在」
        raise HTTPException(status_code=404, detail="找不到這個對話")

    valid = {u["username"] for u in users.list_active()}
    for name in req.usernames:
        # 不存在的帳號、停用的帳號、還有自己,一律略過而不是報錯 ——
        # 選單是前端給的,對不上多半是清單過期,沒必要讓整批分享失敗
        # (字元與長度在 ShareRequest 的 pattern 就擋掉了)
        if name == viewer or name not in valid:
            continue
        shares.add(db, conversation_id, name, viewer)

    names = users.display_names()
    return [
        schemas.ShareEntry(
            username=s.username,
            display_name=names.get(s.username, s.username),
            shared_by=s.shared_by,
        )
        for s in shares.recipients(db, conversation_id)
    ]


@router.delete("/conversations/{conversation_id}/share/{username}", status_code=204)
def unshare_conversation(
    conversation_id: str = _CONV_ID,
    username: str = _USERNAME,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """取消分享。三種人可以移除:

      owner        —— 任何人。那是他的對話。
      自己         —— 等於「離開共用」。
      邀請人的人   —— 移除自己拉進來的那些人。按錯了要收得回來,
                      不然只能去拜託原作者處理。
    """
    if not shares.can_access(db, conversation_id, viewer):
        raise HTTPException(status_code=404, detail="找不到這個對話")

    if shares.owner_of(db, conversation_id) == viewer or username == viewer:
        shares.remove(db, conversation_id, username)
        # 他的提及也一起清 —— 留著的話輪詢還會把便條送給他,未讀數也會掛在
        # 一組他點進去只會 404 的對話上(見 notes.remove_for_user)
        notes.remove_for_user(db, conversation_id, username)
        return

    invited_by_me = next(
        (s for s in shares.recipients(db, conversation_id) if s.username == username),
        None,
    )
    # 已經不在共用清單上了就當成功 —— 兩個人同時把同一個對象移掉是很自然的事
    #(共用清單上看得到彼此),而「他已經不在了」正是這個請求想要的結果。
    if invited_by_me is None:
        return
    if invited_by_me.shared_by != viewer:
        raise HTTPException(status_code=404, detail="找不到這個對話")
    shares.remove(db, conversation_id, username)
    # 他的提及也一起清 —— 留著的話輪詢還會把便條送給他,未讀數也會掛在
    # 一組他點進去只會 404 的對話上(見 notes.remove_for_user)
    notes.remove_for_user(db, conversation_id, username)
