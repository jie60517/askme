/**
 * 截圖存筆記的框選那一層。
 *
 * 背景是剛抓的那一格(`lib/regionShot.ts` 的 `grabTabFrame`),所以畫面看起來凍住了。拖一個框 → 框外變暗、
 * 右下角 ✕ ✓。**按 ✓ 才存**(拖歪了可以重拖,不會多存一則);✕ / Esc 取消、Enter = ✓、
 * 在框外再拖一次就重選。不放說明文字(十字游標本身就說明了)。
 *
 * 凍住的那張**鋪滿寬度、等比例、貼齊上緣**:分享的那一下 Chrome 上方多一條「正在分享」,抓到的那格比現在的視窗矮,
 * 硬撐滿高度會變形;座標換算見 `toImageRect`。
 * 用 portal 掛在 body(同 `SelectionSaveButton`:對話區那幾層有 transform,fixed 會被困住)。
 */
import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import * as stylex from '@stylexjs/stylex';

import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, Stack} from '@astryxdesign/core/Layout';
import {Check, X} from 'lucide-react';

import {portalHost} from '../lib/portalHost';
import {isTooSmall, rectFrom, toImageRect, type Rect} from '../lib/regionShot';

/** ✕ ✓ 那一條大約多寬多高(定位用:靠框的右緣、放不下就翻進框裡) */
const BAR_W = 76;
const BAR_H = 40;
const BAR_GAP = 8;

const styles = stylex.create({
  // 數字見 global.css 的層級表(80)
  stage: {
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    cursor: 'crosshair',
    userSelect: 'none',
    touchAction: 'none',
    outline: 'none',
    backgroundColor: 'var(--color-background-body)',
  },
  frame: {position: 'absolute', top: 0, left: 0, width: '100%', height: 'auto', pointerEvents: 'none'},
  /** 遮罩:還沒拖時整片一塊;拖了之後框的上下左右四塊。顏色是對話框遮罩那個 token */
  dim: {position: 'absolute', backgroundColor: 'var(--color-overlay)', pointerEvents: 'none'},
  rect: {
    position: 'absolute',
    boxSizing: 'border-box',
    borderWidth: 'var(--focus-outline-width)',
    borderStyle: 'solid',
    borderColor: 'var(--color-accent)',
    pointerEvents: 'none',
  },
  // 底色、陰影、圓角交給 Card(elevation high)。
  // ⚠️ 裡面**不**包 Toolbar:它只留一個 Tab 停點(✓ 要按方向鍵才到),第一次 Tab 進去還會浮出「← → to navigate」提示,
  // 而這一層不放說明文字;上下內距也比 BAR_H 高
  bar: {position: 'absolute', cursor: 'default'},
});

export function RegionPicker({
  image,
  imageUrl,
  onConfirm,
  onCancel,
}: {
  /** 剛抓的那一格(裁切用) */
  image: HTMLCanvasElement;
  /** 同一張的網址(畫在背景) */
  imageUrl: string;
  /** 按了 ✓:框(圖上的像素)。存完 / 失敗由呼叫端收掉這一層 */
  onConfirm: (rect: Rect) => Promise<void>;
  onCancel: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLImageElement>(null);
  const start = useRef<{x: number; y: number} | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const confirm = () => {
    const shownWidth = frameRef.current?.clientWidth || window.innerWidth;
    if (!rect || isSaving) return;
    setIsSaving(true);
    void onConfirm(toImageRect(rect, shownWidth, image));
  };

  // Esc / Enter:蓋上來就拿焦點,鍵盤直接作用在這一層;收掉時焦點還給原本的地方(書籤鈕)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    stageRef.current?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!isSaving) onCancel();
    } else if (e.key === 'Enter' && e.target === e.currentTarget && rect && !isDragging) {
      // 只認焦點在這一層本身時:焦點在 ✕ 上按 Enter 是按 ✕(不擋的話會冒泡上來變成存檔)
      e.preventDefault();
      confirm();
    }
  };

  /** 放開或被打斷(pointercancel):收尾;太小的框當作沒選 */
  const endDrag = () => {
    if (!isDragging) return;
    setIsDragging(false);
    start.current = null;
    if (rect && isTooSmall(rect)) setRect(null);
  };

  const point = (e: React.PointerEvent) => {
    const box = stageRef.current!.getBoundingClientRect();
    return {x: e.clientX - box.left, y: e.clientY - box.top};
  };

  /** ✕ ✓ 放哪:框下面放得下就放下面;不然框夠高就翻進框裡;都不行(貼底又很矮)就放框上面 */
  const barTop = (r: Rect) => {
    if (r.y + r.h + BAR_GAP + BAR_H <= window.innerHeight) return r.y + r.h + BAR_GAP;
    if (r.h >= BAR_H + BAR_GAP * 2) return r.y + r.h - BAR_H - BAR_GAP;
    return Math.max(BAR_GAP, r.y - BAR_H - BAR_GAP);
  };

  return createPortal(
    <Stack
      ref={stageRef}
      xstyle={styles.stage}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Select an area to save"
      onKeyDown={onKeyDown}
      onPointerDown={(e: React.PointerEvent) => {
        // 只有主鍵(左鍵 / 觸控筆)拖框;右鍵不算
        if (e.button !== 0 || isSaving || (e.target as HTMLElement).closest('[data-region-bar]')) return;
        // 拖出視窗外放開也收得到 pointerup
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = point(e);
        setRect({...start.current, w: 0, h: 0});
        setIsDragging(true);
      }}
      onPointerMove={(e: React.PointerEvent) => {
        if (isDragging && start.current) setRect(rectFrom(start.current, point(e)));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <img ref={frameRef} src={imageUrl} alt="" draggable={false} {...stylex.props(styles.frame)} />
      {rect ? (
        <>
          <Stack xstyle={styles.dim} style={{left: 0, right: 0, top: 0, height: rect.y}} />
          <Stack xstyle={styles.dim} style={{left: 0, right: 0, top: rect.y + rect.h, bottom: 0}} />
          <Stack xstyle={styles.dim} style={{left: 0, width: rect.x, top: rect.y, height: rect.h}} />
          <Stack xstyle={styles.dim} style={{left: rect.x + rect.w, right: 0, top: rect.y, height: rect.h}} />
          <Stack xstyle={styles.rect} style={{left: rect.x, top: rect.y, width: rect.w, height: rect.h}} />
        </>
      ) : (
        <Stack xstyle={styles.dim} style={{inset: 0}} />
      )}
      {rect && !isDragging && !isTooSmall(rect) ? (
        <Stack
          xstyle={styles.bar}
          data-region-bar=""
          style={{
            left: Math.max(BAR_GAP, rect.x + rect.w - BAR_W),
            top: barTop(rect),
          }}
        >
          <Card elevation="high" padding={1} width="fit-content">
            <HStack gap={1}>
              <IconButton label="Cancel" variant="ghost" isDisabled={isSaving} icon={<Icon icon={X} size="sm" />} onClick={onCancel} />
              <IconButton
                label="Save to notes"
                variant="primary"
                isLoading={isSaving}
                icon={<Icon icon={Check} size="sm" />}
                onClick={confirm}
              />
            </HStack>
          </Card>
        </Stack>
      ) : null}
    </Stack>,
    // 掛在佈景那一層,不是 body(body 讀不到佈景的 token,見 lib/portalHost.ts)
    portalHost(),
  );
}
