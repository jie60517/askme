/**
 * Bloub 顏色那排最後一顆「調色盤」打開的那塊。它不是 Popover,而是 `CompanionLook`
 * 裡往下展開的一段,殼的動態跟型態 / 顏色那塊同一套。
 *
 * 三樣東西,沒有任何說明字(畫面上不放說明):
 * - 色塊:橫軸飽和度、縱軸亮度
 * - 色相條(不用 Astryx 的 `Slider`:它的軌道畫不出色相漸層,而色相條的軌道本身就是內容)
 * - 色碼(`#rrggbb`)
 *
 * 拖的時候每一格走 `onPreview`(預覽與右下角那隻跟著變);放開、方向鍵、打完一個合法色碼走 `onPick`
 * —— 存帳號、開心一下都等這個,不然拖一下就送幾十個請求。
 *
 * ⚠️ 漸層裡的色碼是**內容資料**(色相環本身),不是介面配色 —— 跟 `CompanionLook` 的色點同一類例外。
 */
import {useEffect, useRef, useState} from 'react';

import {Stack, VStack} from '@astryxdesign/core/Layout';
import {TextInput} from '@astryxdesign/core/TextInput';
import * as stylex from '@stylexjs/stylex';

import {hexToHsv, hsvToHex, parseHexInput, type HexColor, type Hsv} from '../lib/hsv';
import {createPointerOwner} from '../lib/pointerOwner';

/** 把手直徑。把手的中心只在「軌道兩端各縮半顆」的範圍裡走,整顆永遠在軌道裡面(見 `along`) */
const THUMB_PX = 14;
/** 打開時沒有可用的值(不該發生)才用:跟 `companionPref` 的「上次挑的色」預設同一色 */
const FALLBACK: Hsv = {h: 211, s: 0.75, v: 0.94};

/**
 * 0..1 → 把手中心的位置。⚠️ 不能直接寫 `t * 100%`:這塊包在 `CompanionLook` 那層
 * `overflow: hidden` 裡(收合動畫要夾),走到兩端時把手會被切掉半顆。
 */
const along = (t: number) => `calc(${t} * (100% - ${THUMB_PX}px) + ${THUMB_PX / 2}px)`;

const styles = stylex.create({
  pad: {
    /* 焦點框畫在裡面:往外畫的會被同一層 overflow: hidden 切掉 */
    outline: {
      default: 'none',
      ':focus-visible': 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
    },
    outlineOffset: 'calc(var(--focus-outline-width) * -1)',
    position: 'relative',
    height: 140,
    borderRadius: 'var(--radius-element)',
    backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
    cursor: 'crosshair',
    touchAction: 'none',
  },
  hue: {
    outline: {
      default: 'none',
      ':focus-visible': 'var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)',
    },
    outlineOffset: 'calc(var(--focus-outline-width) * -1)',
    position: 'relative',
    height: 12,
    borderRadius: 'var(--radius-full)',
    backgroundImage: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
    cursor: 'pointer',
    touchAction: 'none',
    /* 把手比軌道高一點點,上下留位置給它 */
    marginBlock: 'var(--spacing-1)',
  },
  thumb: {
    position: 'absolute',
    width: THUMB_PX,
    height: THUMB_PX,
    translate: '-50% -50%',
    borderRadius: 'var(--radius-full)',
    boxShadow: '0 0 0 2px var(--color-background-surface), 0 0 0 3px var(--color-border-emphasized)',
    pointerEvents: 'none',
  },
});

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * 在軌道上拖。按下去那一根指標管到放開為止(多點觸控照 `lib/pointerOwner.ts` 的規則),
 * 放開 / 取消在 window 的**捕獲階段**收 —— 冒泡會被別的元件的 stopPropagation 攔掉。
 * 回報的是把手中心能走的那段(見 `along`)上的 0..1。
 */
function useTrackDrag(onMove: (x: number, y: number) => void, onEnd: (x: number, y: number) => void) {
  const owner = useState(createPointerOwner)[0];
  const stop = useRef<(() => void) | null>(null);
  // 拖到一半整塊被收起來 / 對話框被關掉:監聽要拿掉
  useEffect(
    () => () => {
      stop.current?.();
      owner.release();
    },
    [owner],
  );

  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const claim = owner.claim(e);
    if (claim === 'ignored') return;
    if (claim === 'restarted') stop.current?.();
    const el = e.currentTarget;
    el.focus();
    const at = (ev: {clientX: number; clientY: number}): [number, number] => {
      const r = el.getBoundingClientRect();
      return [
        clamp01((ev.clientX - r.left - THUMB_PX / 2) / (r.width - THUMB_PX)),
        clamp01((ev.clientY - r.top - THUMB_PX / 2) / (r.height - THUMB_PX)),
      ];
    };
    onMove(...at(e));
    const move = (ev: PointerEvent) => {
      if (owner.owns(ev)) onMove(...at(ev));
    };
    const up = (ev: PointerEvent) => {
      if (!owner.owns(ev)) return;
      owner.release();
      stop.current?.();
      onEnd(...at(ev));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, {capture: true});
    window.addEventListener('pointercancel', up, {capture: true});
    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up, {capture: true});
      window.removeEventListener('pointercancel', up, {capture: true});
      stop.current = null;
    };
  };
}

export function BlobPalette({
  value,
  onPreview,
  onPick,
  isDisabled,
}: {
  value: HexColor;
  /** 拖曳中每一格 */
  onPreview: (hex: HexColor) => void;
  /** 挑好了:放開、方向鍵、打完一個合法色碼 */
  onPick: (hex: HexColor) => void;
  isDisabled?: boolean;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? FALLBACK);
  const [draft, setDraft] = useState<string>(value);

  // 外面換了值(例如登入後採用了另一台電腦存的)→ 跟上。自己剛送出去的那個本來就等於現在的 hsv,不會重設
  // (重設的話拖到灰階時色相會跳回紅色,見 `lib/hsv.ts` 檔頭)。React 文件「props 變了就調整 state」的寫法
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const next = hexToHsv(value);
    if (next && value !== hsvToHex(hsv)) {
      setHsv(next);
      setDraft(value);
    }
  }

  const show = (next: Hsv): HexColor => {
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    return hex;
  };
  const preview = (next: Hsv) => onPreview(show(next));
  const pick = (next: Hsv) => onPick(show(next));

  /** 方向鍵 → 下一個顏色。有對應才吃掉,不然整個對話框會跟著捲 */
  const arrowKeys = (e: React.KeyboardEvent, nextByKey: Record<string, Hsv>) => {
    const next = nextByKey[e.key];
    if (!next || isDisabled) return;
    e.preventDefault();
    pick(next);
  };

  const dragPad = useTrackDrag(
    (x, y) => preview({...hsv, s: x, v: 1 - y}),
    (x, y) => pick({...hsv, s: x, v: 1 - y}),
  );
  // 拖到最右邊是 360 = 0(紅),跟最左邊同一色;記成 359.9 讓把手停在右端
  const hueAt = (x: number) => ({...hsv, h: Math.min(x * 360, 359.9)});
  const dragHue = useTrackDrag(
    (x) => preview(hueAt(x)),
    (x) => pick(hueAt(x)),
  );

  const current = hsvToHex(hsv);
  return (
    <VStack gap={3}>
      <Stack
        xstyle={styles.pad}
        // 底色是當下色相的純色,上面疊白(左→右)與黑(下→上)兩層
        style={{backgroundColor: `hsl(${hsv.h} 100% 50%)`}}
        role="slider"
        tabIndex={isDisabled ? -1 : 0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={current}
        aria-disabled={isDisabled || undefined}
        onPointerDown={isDisabled ? undefined : dragPad}
        onKeyDown={(e) => {
          const d = e.shiftKey ? 0.1 : 0.02;
          arrowKeys(e, {
            ArrowLeft: {...hsv, s: clamp01(hsv.s - d)},
            ArrowRight: {...hsv, s: clamp01(hsv.s + d)},
            ArrowUp: {...hsv, v: clamp01(hsv.v + d)},
            ArrowDown: {...hsv, v: clamp01(hsv.v - d)},
          });
        }}
      >
        <Stack xstyle={styles.thumb} style={{left: along(hsv.s), top: along(1 - hsv.v), backgroundColor: current}} />
      </Stack>
      <Stack
        xstyle={styles.hue}
        role="slider"
        tabIndex={isDisabled ? -1 : 0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        aria-disabled={isDisabled || undefined}
        onPointerDown={isDisabled ? undefined : dragHue}
        onKeyDown={(e) => {
          const d = e.shiftKey ? 30 : 5;
          arrowKeys(e, {ArrowLeft: {...hsv, h: (hsv.h - d + 360) % 360}, ArrowRight: {...hsv, h: (hsv.h + d) % 360}});
        }}
      >
        <Stack
          xstyle={styles.thumb}
          style={{left: along(hsv.h / 360), top: '50%', backgroundColor: `hsl(${hsv.h} 100% 50%)`}}
        />
      </Stack>
      <TextInput
        label="Hex"
        isLabelHidden
        size="sm"
        value={draft}
        isDisabled={isDisabled}
        onChange={(text) => {
          setDraft(text);
          const hex = parseHexInput(text);
          const next = hex && hexToHsv(hex);
          if (!hex || !next) return;
          setHsv(next);
          onPick(hex);
        }}
      />
    </VStack>
  );
}
