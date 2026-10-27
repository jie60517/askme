"""帳號管理。全部限管理員(require_admin),每個變更都寫稽核。

帳號建立/刪除、權限變更一律走這裡,所以每個動作都留痕 —— 直接改資料庫
的話沒有程式經手,記不到。
"""

import anyio
from fastapi import APIRouter, Depends, Header, HTTPException, Request

from .. import audit, auth, config, mfa, ratelimit, schemas, terminal, users, workflow_engine

router = APIRouter(prefix="/api", tags=["admin-users"])


def _require_default_password() -> None:
    """建帳號與重設密碼都要發初始密碼;.env 沒設就當場說清楚,不要退回程式裡的任何字串。"""
    if not config.default_user_password_is_usable():
        raise HTTPException(
            status_code=409,
            detail="設定檔(.env;Docker 是 askme.env)還沒設 DEFAULT_USER_PASSWORD(初始密碼),設好並重啟服務後再建帳號或重設密碼",
        )


def _apply(ok: bool, what: str) -> None:
    """`users.set_*` 說寫失敗就當場 500,**不要往下走去寫稽核**。

    為什麼要有這一支:那幾支寫資料庫的函式失敗時回 False,呼叫端不看的話就是
    最糟的一種錯 —— 畫面顯示成功、稽核記了一筆「停用帳號 ming」,而 ming
    其實還能登入。稽核要的是「紀錄跟事實對得上」,對不上的紀錄比沒有紀錄更糟。
    每一種寫入都要走這裡,不要只包其中一種。
    """
    if not ok:
        raise HTTPException(status_code=500, detail=f"{what}改不動,請再試一次")


@router.get("/users", response_model=list[schemas.UserOut], dependencies=[Depends(auth.require_admin)])
def list_users():
    return users.list_users()


@router.post("/users", response_model=schemas.UserOut, status_code=201)
def create_user(
    req: schemas.CreateUserRequest,
    request: Request,
    admin: str = Depends(auth.require_admin),
):
    # 管理員與 Work Flow 對話的擁有者是保留名(users.is_reserved_name);不分大小寫,
    # 先在這裡擋,使用者看到的才是原因而不是 create_user 那一道的「建立失敗」
    if users.is_reserved_name(req.username):
        raise HTTPException(status_code=400, detail=f"「{req.username}」是系統保留的帳號名,不能使用")
    if users.exists(req.username):
        raise HTTPException(status_code=409, detail="這個帳號已經存在")
    _require_default_password()
    if not users.create_user(req.username, req.display_name, created_by=admin):
        raise HTTPException(status_code=500, detail="建立失敗,請再試一次")

    audit.record(
        "account_created",
        actor=admin,
        ip=ratelimit.client_ip(request),
        # 新帳號一律是預設職稱 = 唯讀。要給完整權限是另一次操作、另一筆稽核。
        detail=f"建立帳號 {req.username},職稱 {users.DEFAULT_ROLE}(唯讀)",
    )
    return next(u for u in users.list_users() if u["username"] == req.username)


@router.patch("/users/{username}", response_model=schemas.UserOut)
def update_user(
    username: str,
    req: schemas.UpdateUserRequest,
    request: Request,
    admin: str = Depends(auth.require_admin),
):
    if not users.exists(username):
        raise HTTPException(status_code=404, detail="找不到這個帳號")

    ip = ratelimit.client_ip(request)

    # 職稱。**用 model_fields_set 判斷有沒有帶** —— 帶空字串是「清掉」,
    # 沒帶是「不動」,只看 `is not None` 的話這兩件事會變成同一件。
    if "role" in req.model_fields_set:
        # 直接把收乾淨的字串交給 set_role:空字串就是「清掉」(它存 NULL)。
        new_role = users.normalize_role(req.role)
        _apply(users.set_role(username, new_role), "職稱")
        # ⚠️ 稽核一定要把**權限的後果**寫進去(職稱就是權限)。
        # 權限沒有自己的稽核事件,事後查「誰給了他 Bash 權限」只能查到這一筆 ——
        # 只記「職稱改為 Software engineer」的話,看不出那一刻他拿到了 Bash。
        _grants_full = users.role_grants_full(new_role)
        audit.record(
            "role_changed",
            actor=admin,
            ip=ip,
            detail=(
                f"{username} 職稱改為 {new_role}(權限:{'完整' if _grants_full else '唯讀'})"
                if new_role
                else f"清掉 {username} 的職稱(權限:唯讀)"
            ),
        )

    # 停用 / 啟用
    if req.disabled is not None:
        _apply(users.set_disabled(username, req.disabled), "帳號狀態")
        audit.record(
            "account_disabled" if req.disabled else "account_enabled",
            actor=admin,
            ip=ip,
            detail=f"{'停用' if req.disabled else '啟用'}帳號 {username}",
        )
        # 停用時,把他已經發出的登入 token 也作廢 —— 不然他當下那個分頁還能用到過期
        if req.disabled:
            auth.revoke_all_for(username)

    return next(u for u in users.list_users() if u["username"] == username)


@router.post("/users/{username}/reset-password", status_code=204)
def reset_password(username: str, request: Request, admin: str = Depends(auth.require_admin)):
    if not users.exists(username):
        raise HTTPException(status_code=404, detail="找不到這個帳號")
    _require_default_password()
    if not users.reset_password(username):
        raise HTTPException(status_code=500, detail="重設失敗,請再試一次")
    # 重設後舊 token 作廢,對方要用預設密碼重新登入、然後被強制改
    auth.revoke_all_for(username)
    audit.record(
        "password_reset", actor=admin, ip=ratelimit.client_ip(request), detail=f"重設 {username} 的密碼"
    )


@router.get(
    "/admin-account",
    response_model=schemas.AdminAccountOut,
    dependencies=[Depends(auth.require_admin)],
)
def admin_account():
    """管理員自己的手機驗證狀態。

    **他不在 `/api/users` 那份清單裡**(不在 users 表),所以帳號管理頁要
    另外撈這一筆,不然他自己永遠發不到 QR —— 而那會讓 `MFA_REQUIRED`
    根本開不起來(見 schemas.AdminAccountOut)。

    網址用 `/admin-account` 而不是 `/users/admin`:後者會被
    `/users/{username}` 吃掉,變成「查一個叫 admin 的帳號」。
    """
    return schemas.AdminAccountOut(
        username=config.ADMIN_USERNAME,
        mfa_enabled=mfa.is_enabled(config.ADMIN_USERNAME),
        mfa_required=config.MFA_REQUIRED,
    )


@router.post("/users/{username}/mfa", response_model=schemas.MFAEnrollResponse)
def issue_mfa(
    username: str,
    request: Request,
    admin: str = Depends(auth.require_admin),
    authorization: str = Header(default=""),
):
    """配一組新的手機驗證碼給這個帳號,回傳畫 QR 需要的東西。

    這是**發放**與**重新發放**同一支:手機壞了、換手機、掃失敗,管理員再按一次
    就好,舊的當場作廢。使用者那一側沒有任何自助入口(見 mfa.py 的模組說明)。

    ⚠️ **重新產生會把舊的立刻停用。** 使用者還沒掃新的 QR 之前就登不進來了,
    所以畫面上一定要講清楚,而且最好當面掃完再走。

    ⚠️ 帳號存不存在**故意不檢查**:管理員本人不在 `users` 表裡,而他也需要
    被發一組(`MFA_REQUIRED` 開著時他自己也會被擋)。
    """
    result = mfa.issue(username)
    # 舊的登入一起踢掉:重新產生的情境多半是「手機不見了」,而那支手機上
    # 可能還開著一個已登入的分頁。
    #
    # ⚠️ **但要保留操作者自己這一張。** 管理員也需要一組(他自己也會被
    # `MFA_REQUIRED` 擋),而他發給自己的時候,不留就是「按下產生的同一秒被登出」
    # —— 畫面跳回登入頁,那張還沒掃的 QR 當場消失,而它再也叫不回來。
    auth.revoke_all_for(username, keep_token=auth.bearer_token(authorization))
    audit.record(
        "mfa_issued",
        actor=admin,
        ip=ratelimit.client_ip(request),
        detail=f"為 {username} 產生手機驗證碼(舊的已失效)",
    )
    return schemas.MFAEnrollResponse(**result)


@router.delete("/users/{username}", status_code=204)
def delete_user(username: str, request: Request, admin: str = Depends(auth.require_admin)):
    if not users.exists(username):
        raise HTTPException(status_code=404, detail="找不到這個帳號")
    archived = users.delete_user(username)
    if not archived:
        raise HTTPException(status_code=500, detail="刪除失敗,請再試一次")
    # 記憶體裡以帳號名為 key 的東西也要收,不然同名帳號重建後接得到:
    # 還開著的 SSH 終端機連線、帳號層的登入失敗計數。這支是同步路由(跑在 worker thread),連線要回事件迴圈去關。
    name = archived.rsplit("#deleted-", 1)[0]
    anyio.from_thread.run(terminal.close_user, name)
    workflow_engine.archive_runner(name, archived)
    ratelimit.reset(username=name.lower())
    # MFA 綁定跟著帳號一起消失。留著的話,同名帳號被重建之後會**繼承前一個人的
    # 綁定** —— 新的使用者拿到帳號卻進不去,而畫面上完全看不出原因。
    mfa.revoke(username)
    auth.revoke_all_for(username)
    audit.record(
        "account_deleted", actor=admin, ip=ratelimit.client_ip(request), detail=f"刪除帳號 {username}"
    )
