"""稽核事件的寫入。

一條原則:**稽核寫入失敗,絕不能讓主流程跟著失敗。** 登入不該因為「稽核那一筆
沒寫成」而登不進去。所以這裡把例外全部吞掉(頂多漏記一筆,不影響使用者)。

用獨立的 DB session:呼叫端(登入、改密碼)有自己的交易,稽核不該跟它們綁在一起
—— 主流程 rollback 不該把稽核紀錄也一起 rollback 掉,反之亦然。
"""

import logging
from typing import Optional

from .database import SessionLocal
from . import models

logger = logging.getLogger(__name__)


def record(event: str, actor: Optional[str] = None, ip: Optional[str] = None, detail: Optional[str] = None) -> None:
    db = SessionLocal()
    try:
        db.add(models.AuditLog(event=event, actor=actor, ip=ip, detail=detail))
        db.commit()
    except Exception:  # noqa: BLE001 —— 稽核是旁路,任何錯誤都不該往上冒
        db.rollback()
        # 只留一行 log 給維運看,不 raise
        logger.warning("稽核事件寫入失敗:event=%s actor=%s", event, actor, exc_info=True)
    finally:
        db.close()
