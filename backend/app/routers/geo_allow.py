# -*- coding: utf-8 -*-
"""地理封鎖的例外清單:看、加、刪。只有管理員能用。

增刪**不用重啟服務** —— 所以名單存資料庫(`models.GeoAllowIP`),而不是 .env 再多一個變數;
按下新增的那一秒,下一次登入就看得到(`geo_allow.match` 是現查的)。

⚠️ **這一頁開的是門,不是設定。** 每一次增刪都寫稽核(`geo_allow_added` /
`geo_allow_removed`,detail 是正規化後的網段),而「這條是誰開的、什麼時候開的」
就只查得到那裡 —— 清單本身只有 IP 一欄。

⚠️ 放行的範圍、擋下來的填法(`0.0.0.0/0`、太大的網段、內網位址)全部在
`app/geo_allow.py`,這裡只負責把錯誤翻成 400 跟記稽核。
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import audit, auth, geo_allow, ratelimit, schemas

router = APIRouter(prefix="/api", tags=["geo-allow"])


def _to_entry(row) -> schemas.GeoAllowEntry:
    """DB 的一列 → 回應。"""
    return schemas.GeoAllowEntry(cidr=row.cidr, created_at=row.created_at)


@router.get(
    "/geo-allow",
    response_model=List[schemas.GeoAllowEntry],
    dependencies=[Depends(auth.require_admin)],
)
def list_geo_allow():
    return [_to_entry(row) for row in geo_allow.entries()]


@router.post(
    "/geo-allow",
    response_model=schemas.GeoAllowEntry,
)
def add_geo_allow(
    req: schemas.GeoAllowRequest,
    request: Request,
    actor: str = Depends(auth.require_admin),
):
    try:
        row = geo_allow.add(req.ip, actor)
    except geo_allow.InvalidEntry as exc:
        # 訊息本來就是寫給人看的中文(見 geo_allow.normalize),照原樣送出去。
        raise HTTPException(status_code=400, detail=str(exc))

    audit.record(
        "geo_allow_added",
        actor=actor,
        ip=ratelimit.client_ip(request),
        detail=row.cidr,
    )
    return _to_entry(row)


@router.post(
    "/geo-allow/remove",
    status_code=204,
)
def remove_geo_allow(
    req: schemas.GeoAllowRequest,
    request: Request,
    actor: str = Depends(auth.require_admin),
):
    """刪一條。

    ⚠️ **刪不到要講出來**(404),不要靜靜回 204:管理員按下「刪除」是為了
    關上一道門,而「按了、沒反應、名單上還在」跟「按了、成功了、畫面沒更新」
    在畫面上長得一模一樣 —— 前者是門還開著。
    """
    removed = geo_allow.remove(req.ip)
    if removed is None:
        raise HTTPException(status_code=404, detail="這一條已經不在名單裡了,重新整理看看。")

    audit.record(
        "geo_allow_removed",
        actor=actor,
        ip=ratelimit.client_ip(request),
        # ⚠️ 記 `removed` 不是 `req.ip`:前者是正規化後的字串,跟新增那一列
        # 用的是同一個寫法 —— 不然同一條白名單的開門與關門在稽核裡對不起來。
        detail=removed,
    )
