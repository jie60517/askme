/**
 * 一個手勢歸哪一根指標管 —— 拖曳類元件的多點觸控保護。
 *
 * 長按拖曳(`useLongPressDrag`)、側邊欄寬度(`SidebarResizer`)、頭像裁切(`AvatarCropper`)、
 * 檔案欄欄寬(`FilePanel` 的 `ColumnResizer`)共用這一份,不要在各處各抄一段判斷 ——
 * 修一個漏洞就得四處一起補,漏一處就只有一半對。
 *
 * 規則(`claim`):
 *  - 沒人在用 → 這一根接手。
 *  - 不是主指標(第二根手指)→ 不理。每一下 pointerdown 都覆寫起點的話,第二根手指一按,
 *    拿著的東西就跳到另一根手指那邊。
 *  - **同一種**指標的主指標又按下來 → 上一次的 pointerup / pointercancel 漏收了
 *    (例如被別的元件攔掉),當成上一次已經結束、換這一根(`restarted`,呼叫端要收掉舊的手勢)。
 *    不這樣的話手勢一直卡著舊的那根,之後每一下都被當成第二根手指 —— 整個控制項死掉。
 *  - **別種**指標的主指標 → 不理:`isPrimary` 是每一種指標各算各的,觸控筆電上滑鼠拖到一半、
 *    另一隻手碰到螢幕,那根手指對觸控來說也是主指標。
 *    ⚠️ 唯一的例外是舊手勢已經 `STALE_MS` 沒有動靜:那多半是收尾事件真的沒送到,
 *    不放行的話換一種指標就永遠用不了(死鎖)。手指按著完全不動超過這麼久、
 *    同時又用滑鼠點下去,才會被搶走 —— 接受。
 */

export type PointerLike = {pointerId: number; pointerType: string; isPrimary: boolean};
export type ClaimResult = 'claimed' | 'restarted' | 'ignored';

/** 舊手勢多久沒有動靜就當成收尾事件丟了(見檔頭) */
export const STALE_MS = 2000;

export type PointerOwner = {
  /** 按下去了,這一根要不要接手。見檔頭的規則 */
  claim(e: PointerLike): ClaimResult;
  /** 這個事件是不是現在管事的那一根發的(是的話順便記一次「還活著」) */
  owns(e: Pick<PointerLike, 'pointerId'>): boolean;
  /** 手勢結束。給事件的話只有管事的那一根放得掉;不給就是無條件收掉(卸載、取消) */
  release(e?: Pick<PointerLike, 'pointerId'>): boolean;
  readonly isActive: boolean;
};

export function createPointerOwner(now: () => number = () => performance.now()): PointerOwner {
  let id: number | null = null;
  let type = '';
  let seenAt = 0;
  const take = (e: PointerLike) => {
    id = e.pointerId;
    type = e.pointerType;
    seenAt = now();
  };
  return {
    claim(e) {
      if (id === null) {
        take(e);
        return 'claimed';
      }
      if (!e.isPrimary) return 'ignored';
      if (e.pointerType !== type && now() - seenAt < STALE_MS) return 'ignored';
      take(e);
      return 'restarted';
    },
    owns(e) {
      if (id === null || e.pointerId !== id) return false;
      seenAt = now();
      return true;
    },
    release(e) {
      if (id === null) return false;
      if (e && e.pointerId !== id) return false;
      id = null;
      type = '';
      return true;
    },
    get isActive() {
      return id !== null;
    },
  };
}
