import asyncio
import json
import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import (
    agent, auth, config, docgen, ids, models, pdfgen, runs, shares, sheetgen, slidegen, zipgen,
)
from ..database import SessionLocal, get_db
from ..uploads import save_uploads_async

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["ask"])


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


def _mark_crashed(run: runs.Run) -> None:
    """收尾自己爆掉時的最後補救:至少把這筆紀錄從 running 拉出來。

    不做的話 qa_records.status 會一直是 "running",而畫面上那題就一直是
    「回答中」——  下次開機才會被 close_orphan_runs 收掉。

    另開一個 session:_finalize 那個已經因為例外處在不確定的狀態,
    繼續用它只會再拋一次。
    """
    db = SessionLocal()
    try:
        record = db.get(models.QARecord, run.record_id)
        if record is not None:
            record.status = "done"
            record.success = False
            record.error = record.error or "收尾時發生錯誤,這題的紀錄可能不完整。"
            db.commit()
    except Exception:  # noqa: BLE001 —— 這已經是最後一道,再失敗只能放手
        logger.exception("標記收尾失敗的紀錄時又失敗了 record=%s", run.record_id)
    finally:
        db.close()

    # 正常收尾會送一個 "done";這條路徑沒送的話,還接著的人只會看到串流無聲結束。
    # 送一則 error 至少讓畫面停在一個看得懂的狀態,而不是永遠的「回答中」。
    run.emit({"type": "error", "message": "收尾時發生錯誤,這題的紀錄可能不完整。"})


async def _watch(run: runs.Run):
    """把一個執行中的問答轉成 ndjson 串流。

    這裡「只是在看」——  斷線不會影響 run 本身,它跑在自己的背景 task 上。
    follow() 會先把已經發生的事件重播一遍,所以中途才接上的人也看得到前面的內容。
    """
    async for event in run.follow():
        yield _ndjson(event)


def _finalize(run: runs.Run, result: dict) -> None:
    """把跑完(或被停止)的結果寫回資料庫,然後送出 done 事件。

    用自己的 DB session:這段是在背景 task 裡跑的,發出請求的那條連線
    早就結束了,它的 session 也跟著關掉了。
    """
    # 收尾的後處理。**每一支都一定要排在 list_output_files 前面** —— 不然它們產出來
    # 的檔案不會出現在下載清單裡,而畫面上不會有任何錯誤,答案裡還說「已經產生」。
    # test_outputs.py 釘著這裡的順序。
    #
    # 順序本身也有意義,不要隨便調:
    #   apply_copy_manifest  claude 交付主機上既有的檔案時寫的是路徑清單,複製在這裡做
    #   flatten_output_dir   **要排在 copy manifest 之後、其餘後處理之前**:複製進來的
    #                        檔案也要攤平,而下面每一支跟 list_output_files 一樣只掃第一層
    #   apply_csv_exports    .csv → .xlsx(不用 manifest,掃到就轉)
    #   apply_docx_manifest  __docx__.txt 點名的 .md → .docx
    #   apply_pdf_manifest   __pdf__.txt 點名的 .md → .pdf
    #   apply_slides_manifest __slides__.json → .pptx
    #   apply_zip_manifest   **最後** —— 上面幾支產出來的檔案也要包得進去
    knowledge_base = config.get_knowledge_base(run.knowledge_base_id)
    for post_process in (
        agent.apply_copy_manifest,
        agent.flatten_output_dir,
        sheetgen.apply_csv_exports,
        docgen.apply_docx_manifest,
        pdfgen.apply_pdf_manifest,
        slidegen.apply_slides_manifest,
        zipgen.apply_zip_manifest,
    ):
        for message in post_process(run.run_id, knowledge_base):
            run.emit({"type": "notice", "level": "warning", "message": message})

    output_files = agent.list_output_files(run.run_id)
    if not output_files:
        # 每題都會先建一個空的 outputs/{session_id}(不先建的話 claude 得自己 mkdir,
        # 而 mkdir 不在白名單裡)。絕大多數問答不會產生檔案,不收掉的話那個資料夾
        # 會一題留一個,幾個月後就是幾千個空目錄。rmdir 只在真的空的時候會成功。
        try:
            (config.OUTPUT_DIR / run.run_id).rmdir()
        except OSError:
            pass

    db = SessionLocal()
    try:
        record = db.get(models.QARecord, run.record_id)
        if record is not None:
            record.answer = result["answer"]
            record.success = result["success"]
            record.error = result["error"]
            record.duration_ms = result.get("duration_ms")
            record.cost_usd = result.get("cost_usd")
            record.sources = (
                json.dumps(run.sources, ensure_ascii=False) if run.sources else None
            )
            record.output_files = ",".join(output_files) if output_files else None
            record.status = "done"

            # 流水帳。**要先清再寫**:同一個 record_id 理論上只會收尾一次,
            # 但留一道防呆比事後查重複列便宜。
            #
            # 用 bulk_insert_mappings 不用 add_all:一題幾百列,走 ORM 等於
            # 建幾百個物件再一列一列 flush,而這段是在收尾的關鍵路徑上。
            if run.steps:
                db.query(models.QAStep).filter(
                    models.QAStep.qa_record_id == record.id
                ).delete(synchronize_session=False)
                db.bulk_insert_mappings(
                    models.QAStep,
                    [{"qa_record_id": record.id, **step} for step in run.steps],
                )

        # claude session id 只在「這一輪真的跑完」時才記下來。中途被中斷就不寫,
        # 下次送出會配一個全新的 session,不會撞到「Session ID ... is already in use」。
        #
        # 已經有值時要**覆蓋**:換專案會在同一組對話裡重開 session,之後的續問
        # 要接的是新的那一個。同一組對話同時只跑得動一題(重複送會被擋成 409),
        # 所以不會有兩個 run 互相蓋掉的情況。
        #
        # workdir 一定要跟 session id 一起寫、一起覆蓋:兩個是一組的
        # (session 檔存在那個目錄對應的 ~/.claude/projects/ 格子裡)。
        # 只更新其中一邊,下次續問就會拿新 session 去舊目錄找,或反過來。
        # ⚠️ 紀錄不在、或已經被軟刪除,就**不要**寫 meta。刪對話會 request_stop()
        # 這一題,而這裡是背景 task,跑到的時候刪除流程已經把 meta 刪掉了 ——
        # 在這裡再寫回去,那組已刪的對話就留著一個活的 claude session,
        # 知道 conversation_id 的人拿舊網址續問,--resume 會把使用者以為
        # 刪掉的內容整段讀回模型的上下文。
        if run.claude_session_is_new and record is not None and record.deleted_at is None:
            meta = db.get(models.ConversationMeta, run.conversation_id)
            if meta is None:
                db.add(
                    models.ConversationMeta(
                        conversation_id=run.conversation_id,
                        claude_session_id=run.claude_session_id,
                        workdir=run.claude_workdir,
                    )
                )
            else:
                meta.claude_session_id = run.claude_session_id
                meta.workdir = run.claude_workdir
        db.commit()
    finally:
        db.close()

    run.emit(
        {
            "type": "done",
            "id": run.record_id,
            "session_id": run.run_id,
            "conversation_id": run.conversation_id,
            "success": result["success"],
            "error": result["error"],
            "files": output_files,
            "sources": run.sources,
        }
    )
    run.finish()


async def _finalize_off_loop(run: runs.Run, result: dict) -> None:
    """在工作執行緒裡跑 `_finalize`,而且**一定等它跑完**。

    ⚠️ 不能直接在迴圈上呼叫:收尾要產 pdf/pptx/xlsx/zip、複製既有的原始檔、
    寫幾百列流水帳,全是同步的。只有一個 uvicorn 行程時,那幾秒裡**所有人**
    的串流、側欄輪詢都會停住。emit 從執行緒呼叫是安全的,見 runs.Run._wake。

    取消不能打斷收尾。在這裡被取消的兩種情況,都先等它跑完 ——
      - 使用者在收尾那幾秒按停止:答案已經答完了,沒有東西可停 → 取消就此吞掉;
      - 服務收攤:放掉的話執行緒還在寫,外面卻已經跑了 finally 的 run.finish(),
        done 事件會晚於結束才送出,紀錄可能寫一半 → 等完之後**把取消丟回去**,
        讓呼叫端照常收攤。
    """
    work = asyncio.ensure_future(asyncio.to_thread(_finalize, run, result))
    cancelled = False
    while not work.done():
        try:
            await asyncio.shield(work)
        except asyncio.CancelledError:
            cancelled = True
    work.result()  # _finalize 自己的例外從這裡帶出去,交給呼叫端的 except
    if cancelled and not run.stop_requested:
        raise asyncio.CancelledError


def _record_tool_duration(run: runs.Run, event: dict) -> None:
    """某一步工具真正的耗時是**晚到**的(要等 tool_result 回來),回頭補兩個地方。

    1. 流水帳 `run.steps`(管理員的題目明細)。
    2. 畫面用的 `run.sources`,並 emit `source_duration` 給正在看的人。
       拿相鄰兩步的 at_ms 相減量到的是「到下一步之前」,最後一步更是一路算到答案寫完,
       跟工具本身的耗時可以差一個數量級。

    由後往前找:同一個 tool_use_id 只會有一列,而它幾乎一定在尾巴。
    sources 去重過,同一個目標第二次呼叫不會有自己的那一列 —— 找不到就不補。
    """
    tool_use_id = event["tool_use_id"]
    duration_ms = event["duration_ms"]
    for step in reversed(run.steps):
        if step.get("tool_use_id") == tool_use_id:
            step["duration_ms"] = duration_ms
            break
    for source in reversed(run.sources):
        if source.get("tool_use_id") == tool_use_id:
            source["duration_ms"] = duration_ms
            run.emit({"type": "source_duration", "tool_use_id": tool_use_id, "duration_ms": duration_ms})
            break


def _stopped_result(run: runs.Run) -> dict:
    """使用者按停止時的收尾。已經寫出來的內容一定要留著(格式見 agent.partial_answer)。"""
    partial = "".join(run.answer_parts).strip()
    if partial:
        return {
            "success": True,
            "answer": agent.partial_answer(
                partial,
                "這個回答被手動停止,內容並不完整。",
                "上面是停止前已經查到的部分。",
            ),
            "error": None,
        }
    return {"success": False, "answer": "", "error": "已停止(還沒開始產生內容)"}


#: Work Flow 通知對話追問時帶進去幾次執行結果(太多會把真正的問題淹掉)
WORKFLOW_CONTEXT_RUNS = 3


def _workflow_context(db: Session, conv_id: str) -> str:
    """Work Flow 通知對話的前情提要:最近幾次執行結果(標題 + 內容),舊的在前。"""
    recs = (
        db.query(models.QARecord)
        .filter(models.QARecord.conversation_id == conv_id)
        .filter(models.QARecord.owner == config.WORKFLOW_OWNER)
        .filter(models.QARecord.asked_by == config.WORKFLOW_OWNER)
        .filter(models.QARecord.deleted_at.is_(None))
        .order_by(models.QARecord.created_at.desc())
        .limit(WORKFLOW_CONTEXT_RUNS)
        .all()
    )
    if not recs:
        return ""
    parts = [f"【{r.question}】\n{r.answer}" for r in reversed(recs)]
    return "以下是這個 Work Flow 最近幾次的執行結果,請根據它們回答後面的問題:\n\n" + "\n\n".join(parts) + "\n\n問題:"


async def _execute(run: runs.Run, **kwargs) -> None:
    """背景執行一題問答。這個 task 的生命週期跟任何一條 HTTP 連線都無關。"""
    gen = agent.stream_agent(**kwargs)
    result: Optional[dict] = None
    try:
        async for event in gen:
            etype = event["type"]
            if etype == "delta":
                run.answer_parts.append(event["text"])
                run.emit(event)
            elif etype == "answer_reset":
                # 模型又要去呼叫工具,剛剛那幾句是過場話不是答案(agent.py 的 answer_start_index,
                # 存進 DB 的 answer 也是切掉它們的)。要轉送給前端(runs.ts 收到會清),
                # 不然過場話留在畫面上,答完那一刻整段被換掉、版面跳一下。
                # answer_parts 一起清:按停止時留下的部分答案也不該包含過場話。
                run.answer_parts.clear()
                run.emit(event)
            elif etype == "source":
                # ⚠️ **每一步都存,不過濾。** 只存讀取類(Read/Grep/Glob/Bash)的話,
                # 一題只用 WebSearch/WebFetch/Write 的問答答完之後時間軸會**整段消失**
                # (串流當下看得到,重畫就沒了)。
                # record.sources 是「執行過程」的完整紀錄;「參考來源」的過濾
                # 在唯一需要那個語意的地方 —— 前端匯出 Markdown 時(READ_TOOLS)。
                run.sources.append(
                    {
                        "tool": event["tool"],
                        "target": event["target"],
                        "detail": event.get("detail"),
                        # 答完之後那條時間軸的耗時靠它(相對毫秒)
                        "at_ms": event.get("at_ms"),
                        # 工具真正的耗時晚到,用這個 id 補回來(_record_tool_duration)
                        "tool_use_id": event.get("tool_use_id"),
                    }
                )
                run.emit(event)
            elif etype == "step":
                # ⚠️ **只收不 emit**。這是給管理員事後查成本的流水帳,一題可能幾百列;
                # 送進 events 的話每個重新接上的訂閱者都要重播一遍,而畫面上根本不用它
                # (畫面用的是上面那份去重過的 sources)。
                #
                # 整包收下、只去掉 `type`,不要逐欄轉抄:欄位清單已經在
                # `models.QAStep` 與 `agent._describe_usage` 各寫過一次,
                # 這裡再抄第三次的話,加一個欄位就會有一處忘了改 —— 而症狀是
                # 那個欄位在資料庫裡永遠是 NULL,畫面上看不出是漏接還是真的沒有。
                run.steps.append({k: v for k, v in event.items() if k != "type"})
            elif etype == "step_duration":
                _record_tool_duration(run, event)
            elif etype in ("ping", "queued", "notice"):
                run.emit(event)
            elif etype == "error":
                result = {"success": False, "answer": "", "error": event["message"]}
            elif etype == "done":
                result = {
                    "success": event["success"],
                    "answer": event["answer"],
                    "error": event.get("error"),
                    "duration_ms": event.get("duration_ms"),
                    "cost_usd": event.get("cost_usd"),
                }
    except asyncio.CancelledError:
        # aclose() 會讓 stream_agent 裡的 GeneratorExit 跑起來,把 claude 子行程砍掉。
        await gen.aclose()
        if not run.stop_requested:
            # 不是使用者按停止,是整個服務要收攤 —— 紀錄留在 running,
            # 下次啟動時由 close_orphan_runs 收尾。
            raise
        result = _stopped_result(run)
    except Exception as exc:  # noqa: BLE001 - 背景 task 的例外沒人接,一定要自己收
        result = {
            "success": False,
            "answer": "",
            "error": f"執行時發生非預期的錯誤:{type(exc).__name__}: {exc}",
        }

    if result is None:
        # 串流結束卻沒有 done/error —— 通常是 claude 被外部砍掉
        result = {"success": False, "answer": "", "error": "claude 沒有回傳結果就結束了"}

    try:
        await _finalize_off_loop(run, result)
    except Exception:  # noqa: BLE001 —— 背景 task 的例外沒人接
        logger.exception(
            "收尾失敗 conversation=%s record=%s", run.conversation_id, run.record_id
        )
        _mark_crashed(run)
    finally:
        # ⚠️ **run.finish() 一定要跑到。**
        #
        # 只寫在 _finalize 的最後一行是不夠的,_finalize 是會拋例外的:
        # db.commit() 可能撞上「database is locked」(見 database.py 的
        # busy_timeout)、list_output_files 可能 OSError、
        # bulk_insert 可能失敗。拋了就跑不到那一行,於是 run.done 永遠是 False。
        #
        # 後果不是「少一筆紀錄」,是**那條對話從此廢掉**:runs._evict_expired
        # 只清 done 的,所以這個 run 永遠留在 _runs 裡,active_for_conversation
        # 一直找得到它 —— 之後每次送出都是 409,而前端的 409 路徑會去接一條
        # 再也不會有任何事件的死串流(畫面永遠停在「回答中」,重整、換機器都一樣)。
        # 只有重啟服務才會好。
        #
        # finish() 重複呼叫是安全的(只是設旗標 + 叫醒訂閱者)。
        run.finish()


@router.post("/ask")
async def ask(
    question: str = Form(...),
    files: List[UploadFile] = File(default=[]),
    conversation_id: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
    effort: Optional[str] = Form(None),
    kb: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    owner: str = Depends(auth.require_user),
):
    # conversation_id 是前端產生的,但 API 是公開的,不能假設格式一定正確。
    # 它會進資料庫查詢、也會變成側邊欄連結,擋掉奇怪的字元最省事。
    if conversation_id and not ids.REGEX.fullmatch(conversation_id):
        raise HTTPException(status_code=400, detail="conversation_id 格式不正確")
    # `workflow-<流程 id>` 是 Work Flow「通知人員」寫結果的那組對話(workflow_engine._post_note)。
    # 流程 id 是連號,登入者搶先問一題就成了 owner,之後每次執行結果都寫進他的對話、再分享給被通知的人。
    # ⚠️ 只擋**還不存在**的那種(搶建)。已經建好的 Work Flow 通知對話,分享給你的照常能續問
    # (下面 `_workflow_context` 那段的追問);存在的那種交給下面的 owner / 分享判斷(不是 owner、也沒分享給你 → 404)。
    # `owner_of` 不算已刪除的紀錄:刪掉的通知對話照樣不能被搶建回來。
    # Work Flow 沒開也照擋:之後才開的話,先被搶建的那組對話一樣會收到執行結果。
    existing_owner = shares.owner_of(db, conversation_id) if conversation_id else None
    if (
        conversation_id
        and conversation_id.lower().startswith("workflow-")
        and existing_owner is None
    ):
        raise HTTPException(status_code=400, detail="conversation_id 格式不正確")

    # 續問別人的對話要擋掉,**除非那組對話分享給了他**。不擋的話,拿到網址的人
    # 可以往別人的對話裡塞問題,而原主人下次打開會看到不是自己問的東西。
    #
    # 同一組對話裡的 owner 必須從頭到尾一致 —— 這是 conversations.py 那邊可以
    # 放心用「任一筆紀錄的 owner」代表整組對話的前提。所以共用者續問時,新的那筆
    # 紀錄仍然掛在**原 owner** 名下(見下面的 record_owner),不是掛在他自己名下。
    record_owner = owner
    if conversation_id:
        if existing_owner is not None and existing_owner != owner:
            if not shares.can_access(db, conversation_id, owner):
                raise HTTPException(status_code=404, detail="找不到這個對話")
            record_owner = existing_owner

    # 先清一次:紀錄裡存的要跟真的送給 claude 的是同一份文字,
    # 不然歷史上看到的問題跟它實際回答的問題會對不起來。
    question = agent.sanitize_text(question, config.MAX_QUESTION_CHARS)
    if not question:
        raise HTTPException(status_code=400, detail="問題是空的,請輸入內容再送出")

    conv_id = conversation_id or str(uuid.uuid4())

    # 409 守衛與 register 之間**不能被 await 隔開** —— 中間要存附件、寫紀錄,
    # 每一個讓出點都讓同一組對話的第二個請求得以雙雙通過守衛,對同一個 claude
    # session 各起一次 --resume。所以整段圈在這把每組對話一把的鎖裡面
    # (理由與生命週期見 runs.conversation_gate)。
    async with runs.conversation_gate(conv_id):
        if runs.active_for_conversation(conv_id) is not None:
            raise HTTPException(status_code=409, detail="這組對話還有一題正在回答,請等它跑完")

        session_id = uuid.uuid4().hex

        # 同一組對話裡可以換專案,但**換專案一定要開一個新的 claude session**。
        #
        # 續問走的是 `--resume`,前面那些「請以 X 專案的程式碼為準」的上下文還留著;
        # 直接沿用的話會變成同一段對話裡兩套互相矛盾的指示,而答案表面完全看不出來。
        # 所以偵測到專案變了就重開 session —— 使用者不必為了換專案另開一組對話,
        # 代價只是那一題接不到前面的上下文(本來也不該接,那是另一棵程式碼樹的事)。
        # ⚠️ 兩處 `deleted_at IS NULL`(這裡與下面那個舊 session 的回退)是**刪除的
        # 一部分**,不是防禦性寫法:刪對話走軟刪除,列還在資料表裡。濾掉它們,
        # 拿舊網址續問才會被當成一組全新的對話 —— 不然那組已刪的對話會從下一題
        # 開始長回來,而且 `--resume` 會把舊內容整段讀回模型的上下文。
        current_kb = (
            db.query(models.QARecord.knowledge_base)
            .filter(models.QARecord.conversation_id == conv_id)
            .filter(models.QARecord.deleted_at.is_(None))
            .filter(models.QARecord.knowledge_base.isnot(None))
            .order_by(models.QARecord.created_at.desc())
            .limit(1)
            .scalar()
        )
        knowledge_base = config.get_knowledge_base(kb)
        switched_kb = (
            current_kb is not None
            and knowledge_base is not None
            and knowledge_base["id"] != current_kb
        )

        real_files = [f for f in files if f.filename]
        saved_filenames, rejected = (
            await save_uploads_async(session_id, real_files) if real_files else ([], [])
        )

        # 決定要開新的 claude session 還是接續舊的。
        #
        # 前端會自己先產生 conversation_id 再送出(這樣網址跟側邊欄立刻定得下來),
        # 但那個 id 不能直接拿來當 claude 的 session id —— 只要有一次「session 建好了、
        # 紀錄卻沒寫成」,重試就會撞上「Session ID ... is already in use」。
        # 所以 claude 的 session id 另外存在 ConversationMeta,而且只有真的完成過一輪才寫。
        meta = db.get(models.ConversationMeta, conv_id)
        if meta is not None and shares.owner_of(db, conv_id) is None:
            # 這組對話沒有任何一筆活著的紀錄,meta 卻還在:它是刪除流程跟背景收尾
            # 競態留下的殘骸(或一題都沒完成過)。拿它 --resume 會把已刪的內容整段
            # 讀回模型,而且 owner 是 None 時上面那道 can_access 根本不會跑。
            # 當成全新對話:刪掉殘骸,下面會配一個新的 session。
            db.delete(meta)
            db.commit()
            meta = None

        if switched_kb:
            # 換專案 = 換一棵程式碼樹,前面的上下文不但沒用還會誤導,一律重開。
            # 換專案也等於換工作目錄,所以這裡本來就必須重開 —— 舊 session 存在
            # 舊專案的目錄底下,`--resume` 回不去。
            claude_session_id = str(uuid.uuid4())
            is_new_conversation = True
        elif meta is not None and meta.claude_session_id:
            claude_session_id = meta.claude_session_id
            is_new_conversation = False
        elif (
            # Work Flow 的通知對話從來沒有 claude session(那幾題是引擎直接寫進去的),
            # 不能當成「session id = conversation_id」去接 —— 那不是 UUID,每次都會被重開
            not conv_id.startswith("workflow-")
            and db.query(models.QARecord.id)
            .filter(models.QARecord.conversation_id == conv_id)
            .filter(models.QARecord.deleted_at.is_(None))
            .filter(models.QARecord.status == "done")
            .first()
            is not None
        ):
            # 沒有 meta、但有完成過的紀錄:這種對話的 session id 就是 conversation_id 本身,
            # 照這個接續,不然這類對話會續不上。
            claude_session_id = conv_id
            is_new_conversation = False
        else:
            # 全新的(或上次沒跑完的)—— 一律配一個沒用過的 session id。
            # 一定要用 str(uuid4()) 這種「有連字號」的標準格式,不能用 .hex ——
            # claude CLI 會擋:「Invalid session ID. Must be a valid UUID.」
            claude_session_id = str(uuid.uuid4())
            is_new_conversation = True

        # 這一題要在哪個目錄裡跑 claude。決定的是「載入誰的 CLAUDE.md / skill、
        # session 存到哪一格」,跟 --add-dir 的「讀得到哪些程式碼」是兩回事。
        #
        #   新 session(含換專案) → 這個專案自己的工作目錄。隔離就是在這一步成立的。
        #   續問                   → **當初建那個 session 的目錄**,不是現在選的專案。
        #                            claude 的 session 檔存在 ~/.claude/projects/<目錄代號>/,
        #                            換了 cwd 就是查無此 session,那組對話會從此續不下去。
        #
        # meta.workdir 是 NULL 的對話,session 存在 CLAUDE_WORKDIR 底下 ——
        # resolve_workdir 沒拿到 explicit 時會落到那裡。
        if is_new_conversation:
            claude_workdir = config.resolve_workdir(knowledge_base)
        else:
            claude_workdir = config.resolve_workdir(explicit=meta.workdir if meta else None)

        # 這組對話前幾題的題號。唯讀帳號的讀取範圍是按 session_id 逐格放行的
        # (見 agent.scope_readonly_tools),而附件是**每一題**一個資料夾
        # —— 不把前幾題的題號帶下去,續問就讀不到第 1 題附的那份 PDF。
        #
        # ⚠️ 只查這組對話自己的,而且**照登入身分查不到的就不會在這裡出現**:
        # conv_id 是上面已經驗過可見性的那一組(見 _conversation_guard)。
        # 往回幾題與取捨寫在 config.PRIOR_SESSION_DIRS_LIMIT 上面。
        prior_session_ids = [
            sid
            for (sid,) in db.query(models.QARecord.session_id)
            .filter(models.QARecord.conversation_id == conv_id)
            .filter(models.QARecord.deleted_at.is_(None))
            .filter(models.QARecord.session_id != session_id)
            .order_by(models.QARecord.created_at.desc())
            .limit(config.PRIOR_SESSION_DIRS_LIMIT)
            .all()
            if sid
        ]

        # 紀錄在這裡就先寫進去,不等 claude 跑完。
        # 這是「關掉分頁也不會弄丟這一題」的關鍵:對話清單、歷史、網址從第一秒就成立。
        record = models.QARecord(
            session_id=session_id,
            conversation_id=conv_id,
            question=question,
            answer="",
            uploaded_filename=",".join(saved_filenames) if saved_filenames else None,
            knowledge_base=knowledge_base["id"] if knowledge_base else None,
            # 共用對話由別人續問時,這裡掛的是**原 owner** 而不是發問的人 ——
            # 一組對話的 owner 從頭到尾一致,是「任一筆紀錄的 owner 代表整組」的前提。
            owner=record_owner,
            # 相對的,這裡記的是**真的按下送出的那個人**。共用對話裡兩者會不一樣,
            # 而檔案區要顯示「這個附件是誰傳的」只能靠它 —— 用 owner 的話,
            # 同事傳的檔案會被標成原作者的名字。
            asked_by=owner,
            status="running",
            success=True,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

        run = runs.Run(
            run_id=session_id,
            conversation_id=conv_id,
            record_id=record.id,
            question=question,
            knowledge_base_id=knowledge_base["id"] if knowledge_base else None,
            # run 的 owner 同樣用原 owner,這樣 /ask/runs 與串流的可見性判斷
            # (owner 或被分享者)對雙方都成立
            owner=record_owner,
        )
        run.claude_session_id = claude_session_id
        run.claude_session_is_new = is_new_conversation
        # 在 Work Flow 的通知對話裡**第一次**追問:AI 沒看過那幾次執行結果(引擎直接寫進資料庫的),
        # 把最近幾次當成前情提要放在問題前面。紀錄裡存的仍是使用者打的字
        agent_question = question
        if is_new_conversation and conv_id.startswith("workflow-"):
            agent_question = _workflow_context(db, conv_id) + question
        run.claude_workdir = claude_workdir

        # start 事件讓前端立刻知道這一題的紀錄 id 與 run id ——
        # 重新整理之後要靠 run id 才接得回來,不能等到 done 才給。
        run.emit(
            {
                "type": "start",
                "id": record.id,
                "run_id": session_id,
                "session_id": session_id,
                "conversation_id": conv_id,
                "knowledge_base": knowledge_base["id"] if knowledge_base else None,
            }
        )

        # 換了專案要講一聲。不講的話使用者會覺得「它怎麼突然忘記我前面說的話」——
        # 那是刻意的,不同專案的程式碼不能混在同一段上下文裡回答。
        if switched_kb:
            run.emit(
                {
                    "type": "notice",
                    "level": "info",
                    "message": (
                        f"已切換到「{knowledge_base['label']}」。這一題會重新查這個專案的程式碼,"
                        f"不會延續前面的對話內容。"
                    ),
                }
            )

        # 被略過的附件一定要講。不講的話使用者以為 AI 看過那張截圖,
        # 拿到答非所問的回覆還不知道為什麼。
        for filename, reason in rejected:
            run.emit({"type": "notice", "level": "warning", "message": f"「{filename}」沒有上傳成功:{reason}"})

        runs.register(run)
    run.task = asyncio.create_task(
        _execute(
            run,
            question=agent_question,
            session_id=session_id,
            uploaded_filenames=saved_filenames,
            conversation_id=conv_id,
            model=model,
            effort=effort,
            is_new_conversation=is_new_conversation,
            claude_session_id=claude_session_id,
            knowledge_base=knowledge_base,
            # 依**登入身分**決定工具權限與可寫目錄,不是依請求裡的任何欄位 ——
            # 讓前端能指定的話,等於把權限交給請求方自己填。
            allowed_tools=auth.allowed_tools_for(owner),
            writable_extra_dirs=auth.writable_dirs_for(owner),
            workdir=claude_workdir,
            prior_session_ids=prior_session_ids,
            # 真的按下送出的人(不是 record_owner),算每人的併發名額
            asker=owner,
        )
    )

    return StreamingResponse(_watch(run), media_type="application/x-ndjson")


@router.get("/ask/runs")
def list_runs(
    db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)
):
    """還在跑的問答。前端一載入就問這個,把「離開前問到一半」的對話接回來。

    **共用的對話也要列出來。** 這正是「不要兩個人同時問同一件事」的關鍵 ——
    看不到別人正在跑,就會有人又問一次。
    """
    shared_ids = shares.shared_with(db, viewer)
    return [
        {
            "run_id": r.run_id,
            "conversation_id": r.conversation_id,
            "id": r.record_id,
            "question": r.question,
            "started_at_ms": int(r.started_at * 1000),
            "knowledge_base": r.knowledge_base_id,
        }
        for r in runs.active()
        if r.owner == viewer or r.conversation_id in shared_ids
    ]


def _visible_run(run_id: str, viewer: Optional[str], db: Session) -> runs.Run:
    """看得到才拿得到。看不到跟不存在一律回同一種 404。

    共用者也看得到 —— 而且是**同一條串流**(runs.follow 支援多訂閱者),
    所以他跟發問者一樣,即時看得到「正在讀哪支程式、正在 grep 什麼」。
    """
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="這題已經結束太久,請直接看對話紀錄")
    if run.owner != viewer and not shares.can_access(db, run.conversation_id, viewer):
        raise HTTPException(status_code=404, detail="這題已經結束太久,請直接看對話紀錄")
    return run


@router.get("/ask/runs/{run_id}/stream")
async def watch_run(
    run_id: str,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """重新接上一個還在跑(或剛跑完)的問答,從第一個事件開始重播。

    共用者接的是同一條串流,所以會先重播已經發生的事件(讀了哪些檔、跑了哪些工具)
    再繼續跟,中途才加入也看得到完整過程。
    """
    return StreamingResponse(
        _watch(_visible_run(run_id, viewer, db)), media_type="application/x-ndjson"
    )


@router.post("/ask/runs/{run_id}/stop")
def stop_run(
    run_id: str,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    # 沒有這道檢查的話,知道 run_id 的人可以把別人跑到一半的題目停掉。
    # 共用者也能停 —— 他能續問,就該能停下自己看到跑歪的那一題。
    return {"stopped": _visible_run(run_id, viewer, db).request_stop()}
