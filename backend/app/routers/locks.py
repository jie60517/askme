"""登入鎖定的查詢與解除。只有管理員能用。

⚠️ **這不是「等不了才用」的便利功能,它是唯一的解鎖途徑。** 目前的設定
(`LOGIN_IP_LOCKOUT_SEC=0`)是 IP 層**永久封鎖** —— 不處理就是真的一直鎖著。
帳號層也開著(`LOGIN_MAX_ATTEMPTS` 預設 5 次錯 → 鎖 15 分鐘),那一層自己會到期;
會卡在這裡等人解的通常是 IP 那層。詳見 ratelimit.py 檔頭。

⚠️ 管理員自己也會被鎖(帳號層與 IP 層都適用)。這是刻意的:管理員帳號是
最有價值的目標,給它開後門等於讓那道門可以被無限次嘗試。

⚠️ **重啟不是退路。** IP 層的封鎖會寫進資料庫、開機載回(見 models.LoginIPBlock),
重啟服務不會解開 —— 帳號層是記憶體,重啟才會清掉。真的把自己鎖在門外時,照這個順序:

  1. **從 `LOGIN_IP_ALLOWLIST` 裡的網路連**。那些來源永遠不會被 IP 層鎖住,
     進得去就在這一頁按解鎖。這是設計上預留的那條路。
  2. 連不到那些網路的話,在主機上把自己的 IP 加進白名單再重啟 —— 開機載回時
     會跳過白名單裡的 IP,**並且把那一列刪掉**,等於順手解鎖:

         # 設定檔(本機 backend/.env;Docker 是 askme.env)
         LOGIN_IP_ALLOWLIST=203.0.113.0/24,你現在的IP

     然後重啟服務(Docker:`docker compose restart askme`)。

  3. 真的要直接動資料庫(知道自己在做什麼再用),**改完一定要重啟**,
     不然記憶體裡那份還鎖著:

         DELETE FROM login_ip_blocks WHERE ip='1.2.3.4';
"""

from fastapi import APIRouter, Depends, HTTPException

from .. import auth, ratelimit, schemas

router = APIRouter(prefix="/api", tags=["locks"])


@router.get(
    "/locks",
    response_model=schemas.LocksOut,
    dependencies=[Depends(auth.require_admin)],
)
def list_locks():
    return schemas.LocksOut(**ratelimit.snapshot())


@router.post(
    "/locks/unlock",
    status_code=204,
    dependencies=[Depends(auth.require_admin)],
)
def unlock(req: schemas.UnlockRequest):
    if not req.username and not req.ip:
        raise HTTPException(status_code=400, detail="要指定 username 或 ip")
    ok = ratelimit.reset(username=req.username or None, ip=req.ip or None)
    if not ok:
        # 記憶體已經解開了(這個請求之後他馬上進得來),但資料庫那一列還在,
        # 服務一重啟就會回來。**這件事一定要講** —— 靜靜回 204 的話,管理員
        # 看到的是解鎖成功,下次部署之後那個 IP 又被鎖著,而唯一的線索
        # 在伺服器日誌裡。文案寫「再按一次」是因為這多半是 SQLite 的
        # `database is locked`(有人正在寫),重試通常就過了。
        raise HTTPException(
            status_code=500,
            detail="已經解除鎖定,但沒能從資料庫刪掉這筆封鎖 —— 服務重啟後它會回來,請再按一次解鎖",
        )
