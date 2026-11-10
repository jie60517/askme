"""帳號管理 + 角色(帳號管理頁的兩個分頁)。要有 Users 權限(管理員一律有),每個變更都寫稽核。

帳號建立/刪除、權限變更一律走這裡,所以每個動作都留痕 —— 直接改資料庫
的話沒有程式經手,記不到。

⚠️ **Users 權限可以給角色**,所以這裡每一個會改東西的端點都過 `_guard`:
不擋的話,有 Users 權限的人可以替自己全開,等於管理員。
"""

import logging

import anyio
from fastapi import APIRouter, Depends, Header, HTTPException, Request

from .. import audit, auth, config, mfa, ratelimit, roles, runs, schemas, terminal, users, workflow_engine

router = APIRouter(prefix="/api", tags=["admin-users"])
logger = logging.getLogger(__name__)

require_users = auth.require_perm("users")


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


def _guard(actor: str, request: Request, target: str | None = None, *perms: dict) -> None:
    """有 Users 權限的**一般帳號**不能替自己升權。管理員不受限。

    ① 不能動**自己**的帳號(角色、權限、停用、密碼、手機驗證、刪除);
    ② 只能給出**自己有的**權限 —— `perms` 裡每一份(改之前、改之後)都要被自己的權限包住;
    ③ 所以也動不了權限比自己大的帳號與角色(連重設他的密碼、收回他的權限都不行 —— 前者等於接管他的帳號,
       後者等於一個權限小的人能拔掉權限大的人);
    ④ 碰不到管理員(他不在 users 表,這裡再擋一次名字)。
    擋下來的每一次都記一筆稽核:有人在試權限邊界,事後要查得到。
    """
    if auth.is_admin(actor):
        return
    why = None
    if target is not None and target.strip().lower() == config.ADMIN_USERNAME.lower():
        why = "管理員的帳號只有管理員自己能動"
    elif target is not None and target.strip().lower() == actor.strip().lower():
        why = "不能改自己的帳號,請找管理員"
    else:
        mine = auth.perms_for(actor)
        if any(not roles.covers(mine, p) for p in perms):
            why = "這裡有你自己沒有的權限,只有管理員能改"
    if why:
        audit.record(
            "users_action_denied",
            actor=actor,
            ip=ratelimit.client_ip(request),
            detail=f"{request.method} {request.url.path}:{why}",
        )
        raise HTTPException(status_code=403, detail=why)


def _target(username: str, actor: str, request: Request) -> dict:
    """要動的帳號 {role, own, perms}:不存在 404,動不得(`_guard`)403。每一支會改帳號的端點都先走這裡。"""
    current = roles.access_of(username)
    if current is None:
        raise HTTPException(status_code=404, detail="找不到這個帳號")
    _guard(actor, request, username, current["perms"])
    return current


def _write(what: str, fn, *args, **kwargs):
    """角色 / 權限的寫入(roles.py 用例外回報):說不成立的 → 400 帶原因;寫失敗 → 500「改不動」。

    跟 `_apply` 同一個規則:**失敗就不往下走去寫稽核**。
    """
    try:
        return fn(*args, **kwargs)
    except roles.RoleError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 —— 資料庫寫失敗:畫面要看到中文,不是英文的 Internal Server Error
        logger.exception("%s寫入失敗", what)
        raise HTTPException(status_code=500, detail=f"{what}改不動,請再試一次") from e


def _user_row(username: str) -> dict:
    return next(u for u in users.list_users() if u["username"] == username)


@router.get("/users", response_model=list[schemas.UserOut], dependencies=[Depends(require_users)])
def list_users():
    return users.list_users()


@router.post("/users", response_model=schemas.UserOut, status_code=201)
def create_user(
    req: schemas.CreateUserRequest,
    request: Request,
    admin: str = Depends(require_users),
):
    # 管理員與 Work Flow 對話的擁有者是保留名(users.is_reserved_name);不分大小寫,
    # 先在這裡擋,使用者看到的才是原因而不是 create_user 那一道的「建立失敗」
    if users.is_reserved_name(req.username):
        raise HTTPException(status_code=400, detail=f"「{req.username}」是系統保留的帳號名,不能使用")
    if users.exists(req.username):
        raise HTTPException(status_code=409, detail="這個帳號已經存在")
    # 新帳號一律是預設角色 —— 自己沒有那些權限的人也不能用「建帳號」變出一個有的人
    _guard(admin, request, None, roles.role_perms(users.DEFAULT_ROLE))
    _require_default_password()
    if not users.create_user(req.username, req.display_name, created_by=admin):
        raise HTTPException(status_code=500, detail="建立失敗,請再試一次")

    audit.record(
        "account_created",
        actor=admin,
        ip=ratelimit.client_ip(request),
        # 新帳號一律是預設角色。要給更多權限是另一次操作、另一筆稽核。
        detail=f"建立帳號 {req.username},角色 {users.DEFAULT_ROLE}(權限:{roles.describe(roles.role_perms(users.DEFAULT_ROLE))})",
    )
    return _user_row(req.username.strip().lower())


@router.patch("/users/{username}", response_model=schemas.UserOut)
def update_user(
    username: str,
    req: schemas.UpdateUserRequest,
    request: Request,
    admin: str = Depends(require_users),
):
    current = _target(username, admin, request)
    ip = ratelimit.client_ip(request)

    # 角色與權限。收成「改之後的角色 + 完整權限」再一次寫:
    # perms = 畫面上那份完整清單;沒帶 perms 只換角色 = 個人加減照留
    if req.role is not None or req.perms is not None:
        role_id = req.role if req.role is not None else current["role"]
        role = roles.get_role(role_id)
        if role is None:
            raise HTTPException(status_code=400, detail="找不到這個角色")
        base = role["perms"]
        if req.perms is not None:
            target = req.perms.model_dump()
        elif req.role is not None:
            target = roles.apply(base, current["own"])
        else:
            target = dict(current["perms"])
        after = roles.apply(base, roles.diff(base, target))
        _guard(admin, request, username, after)

        if role_id != current["role"] or after != current["perms"]:
            _write("權限", roles.set_user_access, username, role_id, target)
            # ⚠️ 稽核一定要把**權限的後果**寫進去:只記「角色改為 主管」的話,
            # 事後查「誰給了他 Bash」會對不上任何一筆 —— 而那件事確實發生了,就在這裡。
            if role_id != current["role"]:
                audit.record(
                    "role_changed",
                    actor=admin,
                    ip=ip,
                    detail=f"{username} 角色改為 {role['name']}(權限:{roles.describe(after)})",
                )
            if after != current["perms"]:
                audit.record(
                    "perms_changed",
                    actor=admin,
                    ip=ip,
                    detail=f"{username} 權限:{roles.describe_changes(current['perms'], after)}",
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

    return _user_row(username)


@router.post("/users/{username}/reset-password", status_code=204)
def reset_password(username: str, request: Request, admin: str = Depends(require_users)):
    # 重設別人的密碼 = 拿得到他的帳號:權限比自己大的人不能動(`_guard` ③)
    _target(username, admin, request)
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

    ⚠️ 只有管理員本人打得到(`_guard` ④):有 Users 權限的一般帳號看不到這一塊。
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
    admin: str = Depends(require_users),
    authorization: str = Header(default=""),
):
    """配一組新的手機驗證碼給這個帳號,回傳畫 QR 需要的東西。

    這是**發放**與**重新發放**同一支:手機壞了、換手機、掃失敗,管理員再按一次
    就好,舊的當場作廢。使用者那一側沒有任何自助入口(見 mfa.py 的模組說明)。

    ⚠️ **重新產生會把舊的立刻停用。** 使用者還沒掃新的 QR 之前就登不進來了,
    所以畫面上一定要講清楚,而且最好當面掃完再走。

    管理員本人不在 `users` 表裡,而他也需要被發一組(`MFA_REQUIRED` 開著時他自己也會被擋),
    所以帳號不存在時只放行管理員的名字;發給管理員只有管理員自己能按(`_guard` ④)。

    ⚠️ 名字一定要先正規化成資料庫裡那個寫法再檢查。`mfa.issue` 不分大小寫、會去掉前後空白,
    拿原樣的名字檢查的話,`BOSS` 查不到人、權限比對整段跳過,寫進去的卻是 `boss` 的密鑰。
    """
    username = auth.canonical_username(username)
    current = roles.access_of(username)
    if current is None and not auth.is_admin(username):
        raise HTTPException(status_code=404, detail="找不到這個帳號")
    # 發手機驗證碼 = 拿得到他的第二關:權限比自己大的人不能動(`_guard` ③)
    _guard(admin, request, username, *([current["perms"]] if current is not None else []))
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
def delete_user(username: str, request: Request, admin: str = Depends(require_users)):
    _target(username, admin, request)
    archived = users.delete_user(username)
    if not archived:
        raise HTTPException(status_code=500, detail="刪除失敗,請再試一次")
    # 記憶體裡以帳號名為 key 的東西也要收,不然同名帳號重建後接得到:
    # 還開著的 SSH 終端機連線、帳號層的登入失敗計數。這支是同步路由(跑在 worker thread),連線要回事件迴圈去關。
    name = archived.rsplit("#deleted-", 1)[0]
    anyio.from_thread.run(terminal.close_user, name)
    workflow_engine.archive_runner(name, archived)
    runs.archive_owner(name, archived)
    ratelimit.reset(username=name.lower())
    # MFA 綁定跟著帳號一起消失。留著的話,同名帳號被重建之後會**繼承前一個人的
    # 綁定** —— 新的使用者拿到帳號卻進不去,而畫面上完全看不出原因。
    mfa.revoke(username)
    auth.revoke_all_for(username)
    audit.record(
        "account_deleted", actor=admin, ip=ratelimit.client_ip(request), detail=f"刪除帳號 {username}"
    )


# ------------------------------------------------------------------ 角色(帳號管理頁的「角色」分頁)


@router.get("/roles", response_model=list[schemas.RoleOut], dependencies=[Depends(require_users)])
def list_roles():
    return roles.list_roles()


@router.post("/roles", response_model=schemas.RoleOut, status_code=201)
def create_role(req: schemas.CreateRoleRequest, request: Request, admin: str = Depends(require_users)):
    perms = roles.clean_perms(req.perms.model_dump())
    _guard(admin, request, None, perms)
    role = _write("角色", roles.create_role, req.name, perms, created_by=admin)
    audit.record(
        "role_created",
        actor=admin,
        ip=ratelimit.client_ip(request),
        detail=f"建立角色 {role['name']}(權限:{roles.describe(role['perms'])})",
    )
    return role


@router.patch("/roles/{role_id}", response_model=schemas.RoleOut)
def update_role(role_id: str, req: schemas.UpdateRoleRequest, request: Request, admin: str = Depends(require_users)):
    role = roles.get_role(role_id)
    if role is None:
        raise HTTPException(status_code=404, detail="找不到這個角色")
    perms = roles.clean_perms(req.perms.model_dump()) if req.perms is not None else None
    # 改之前、改之後都要被自己的權限包住(`_guard` ②③):不然可以把自己那個角色的權限加大
    _guard(admin, request, None, role["perms"], *([perms] if perms is not None else []))
    if perms is not None and not auth.is_admin(admin):
        # D9a ③ 也要透過角色成立:改角色等於同時改掛著它的每一個人。只看角色本身的話,
        # 權限小的人可以把一個「自己也有的」角色清空,拔掉某個靠個人加權而比他大的人身上
        # 來自角色的那幾項 —— 直接改那個人會被 _target 擋下。
        # 所以每個實際權限會變的成員,改之前、改之後都要被操作者包住,跟直接改帳號同一把尺;
        # 權限不變的成員不受這次修改影響,不用查。
        # 目標傳 None:操作者自己也掛在這個角色上時,照舊交給上面那道(不能把它加大)判斷 ——
        # 透過角色只拿得掉自己的權限,加不上去。
        for member in roles.members_of(role_id):
            cur = roles.access_of(member)
            if cur is None:
                continue
            after_member = roles.apply(perms, cur["own"])
            if after_member != cur["perms"]:
                _guard(admin, request, None, cur["perms"], after_member)
    before = _write("角色", roles.update_role, role_id, name=req.name, perms=perms)
    after = roles.get_role(role_id)
    ip = ratelimit.client_ip(request)
    if after["name"] != before["name"]:
        audit.record("role_renamed", actor=admin, ip=ip, detail=f"角色 {before['name']} 改名為 {after['name']}")
    if after["perms"] != before["perms"]:
        # 一個角色可能掛著很多人:稽核要寫明影響幾個人
        audit.record(
            "role_perms_changed",
            actor=admin,
            ip=ip,
            detail=(
                f"角色 {after['name']} 權限:{roles.describe_changes(before['perms'], after['perms'])}"
                f"(影響 {after['member_count']} 人)"
            ),
        )
    return after


@router.post("/roles/delete", status_code=204)
def delete_roles(req: schemas.DeleteRolesRequest, request: Request, admin: str = Depends(require_users)):
    """刪一個或好幾個角色(左邊勾選後的「刪除 N 個角色」)。**一個刪不掉就全部不刪**,錯誤一次講完。

    擋的規則與「同一個交易」在 roles.delete_roles(預設角色、有人用、Work Flow 用到 All <角色>)。
    """
    for rid in dict.fromkeys(req.ids):
        role = roles.get_role(rid)
        if role is None:
            raise HTTPException(status_code=404, detail="找不到這個角色")
        _guard(admin, request, None, role["perms"])
    try:
        names = roles.delete_roles(req.ids)
    except roles.RoleError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 —— 資料庫寫失敗(整筆已經回滾)
        logger.exception("刪角色寫入失敗")
        raise HTTPException(status_code=500, detail="角色刪不掉,請再試一次") from e
    ip = ratelimit.client_ip(request)
    for name in names:
        audit.record("role_deleted", actor=admin, ip=ip, detail=f"刪除角色 {name}")
