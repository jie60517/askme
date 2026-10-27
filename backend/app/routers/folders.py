"""側邊欄資料夾:建立、改名、搬動(巢狀)、刪除,以及把對話歸進資料夾。

歸類是**每個人自己的**(見 models.ConversationFolder),所以這裡的每一條查詢
都掛 username == viewer —— 拿得到別人的資料夾 id 也動不了別人的東西。

刪資料夾的語意:**裡面的對話退回未歸類、子資料夾接到上一層**,不是連鎖刪除。
資料夾只是歸類的標籤,刪標籤不該讓人以為對話跟著沒了 —— 對話的刪除有自己的
路徑與確認框,兩件事不能混在一起。
"""

from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import auth, ids, models, schemas, shares
from ..database import get_db

router = APIRouter(prefix="/api", tags=["folders"])

_CONV_ID = ids.path_param()


def _my_folder(db: Session, folder_id: int, viewer: str) -> models.ConversationFolder:
    folder = (
        db.query(models.ConversationFolder)
        .filter(
            models.ConversationFolder.id == folder_id,
            models.ConversationFolder.username == viewer,
        )
        .first()
    )
    if folder is None:
        # 別人的資料夾跟不存在的一視同仁 —— 回 403 等於告訴對方那個 id 存在
        raise HTTPException(status_code=404, detail="找不到這個資料夾")
    return folder


def _would_cycle(db: Session, folder_id: int, new_parent_id: int, viewer: str) -> bool:
    """把 folder 搬到 new_parent 底下會不會繞成一圈(含搬到自己底下)。

    從 new_parent 沿著 parent_id 往上走,途中撞到 folder 自己就是會 ——
    A 底下有 B,再把 A 拖進 B,兩個會互相當對方的祖先,樹就畫不出來了。
    """
    seen: set[int] = set()
    current: Optional[int] = new_parent_id
    while current is not None:
        if current == folder_id:
            return True
        if current in seen:  # 資料已經壞了(不該發生),別跟著無窮迴圈
            return True
        seen.add(current)
        row = (
            db.query(models.ConversationFolder.parent_id)
            .filter(
                models.ConversationFolder.id == current,
                models.ConversationFolder.username == viewer,
            )
            .first()
        )
        if row is None:
            return False
        current = row[0]
    return False


@router.get("/folders", response_model=schemas.FoldersOut)
def list_folders(db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)):
    folders = (
        db.query(models.ConversationFolder)
        .filter(models.ConversationFolder.username == viewer)
        .order_by(models.ConversationFolder.created_at.asc())
        .all()
    )
    items: Dict[str, int] = {
        row.conversation_id: row.folder_id
        for row in db.query(models.ConversationFolderItem)
        .filter(models.ConversationFolderItem.username == viewer)
        .all()
    }
    return schemas.FoldersOut(
        folders=[schemas.FolderOut.model_validate(f) for f in folders], items=items
    )


@router.post("/folders", response_model=schemas.FolderOut, status_code=201)
def create_folder(
    req: schemas.CreateFolderRequest,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="資料夾名稱不能是空的")
    if req.parent_id is not None:
        _my_folder(db, req.parent_id, viewer)  # 掛在別人的(或不存在的)資料夾底下沒有意義
    folder = models.ConversationFolder(username=viewer, name=name, parent_id=req.parent_id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return schemas.FolderOut.model_validate(folder)


@router.patch("/folders/{folder_id}", response_model=schemas.FolderOut)
def update_folder(
    folder_id: int,
    req: schemas.UpdateFolderRequest,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    folder = _my_folder(db, folder_id, viewer)

    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="資料夾名稱不能是空的")
        folder.name = name

    # 「沒帶」跟「帶 null(搬回頂層)」要分開 —— 見 UpdateFolderRequest 的說明
    if "parent_id" in req.model_fields_set:
        if req.parent_id is not None:
            _my_folder(db, req.parent_id, viewer)
            if _would_cycle(db, folder_id, req.parent_id, viewer):
                raise HTTPException(
                    status_code=400, detail="不能把資料夾放進它自己(或它底下的資料夾)裡"
                )
        folder.parent_id = req.parent_id

    db.commit()
    db.refresh(folder)
    return schemas.FolderOut.model_validate(folder)


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(
    folder_id: int, db: Session = Depends(get_db), viewer: str = Depends(auth.require_user)
):
    folder = _my_folder(db, folder_id, viewer)

    # 子資料夾接到上一層,不連鎖刪 —— 刪一層不該把整棵子樹掃掉
    db.query(models.ConversationFolder).filter(
        models.ConversationFolder.username == viewer,
        models.ConversationFolder.parent_id == folder_id,
    ).update({models.ConversationFolder.parent_id: folder.parent_id}, synchronize_session=False)

    # 裡面的對話退回未歸類(刪歸類列,不動對話本身)
    db.query(models.ConversationFolderItem).filter(
        models.ConversationFolderItem.username == viewer,
        models.ConversationFolderItem.folder_id == folder_id,
    ).delete(synchronize_session=False)

    db.delete(folder)
    db.commit()


@router.put("/conversations/{conversation_id}/folder", status_code=204)
def set_conversation_folder(
    req: schemas.SetConversationFolderRequest,
    conversation_id: str = _CONV_ID,
    db: Session = Depends(get_db),
    viewer: str = Depends(auth.require_user),
):
    """把一組對話放進(或移出)資料夾。

    folder_id 為 null = 移出。移出不檢查對話還看不看得到 —— 對話可能剛被
    取消共用,那筆歸類已經是孤兒,「拿掉它」正是使用者要的結果。
    """
    existing = db.get(models.ConversationFolderItem, (viewer, conversation_id))

    if req.folder_id is None:
        if existing is not None:
            db.delete(existing)
            db.commit()
        return

    _my_folder(db, req.folder_id, viewer)
    # 歸類一組看不到的對話沒有意義(id 是猜的、或清單過期)。看不到回 404,
    # 跟 conversations.py 同一個理由:403 等於確認那組對話存在。
    if not shares.can_access(db, conversation_id, viewer):
        raise HTTPException(status_code=404, detail="找不到這個對話")

    if existing is not None:
        existing.folder_id = req.folder_id
    else:
        db.add(
            models.ConversationFolderItem(
                username=viewer, conversation_id=conversation_id, folder_id=req.folder_id
            )
        )
    db.commit()
