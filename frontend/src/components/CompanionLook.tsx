/**
 * 個人設定裡 Companion 那列底下的那一塊。
 *
 * - **預覽台兩隻都有**:Classic 是 GIF、Bloub 是 bloub。切換時交叉淡入淡出 ——
 *   要退場的那隻立刻淡出,要進場的晚 80ms 才落定,新舊不會疊在一起。
 * - **型態 / 顏色兩列只有 Bloub 才長出來**。切回 Classic 時收起來,但值記著
 *   (`lib/companionPref.ts`),再切回 Bloub 還是剛剛那個樣子。
 * - 換型態或顏色時,預覽那隻從**當下**的形狀與顏色變過去(連點不會跳),
 *   然後開心一下(`CHEER_MS`)再回中性臉。
 *
 * 動態全部沿用 `AccountSettingsDialog` 頭貼裁切那排(`actionsRow` / `actionsFade`)的語彙:
 * 殼 420ms `--ease-panel`、內容晚 80ms 用 `--ease-overshoot`、收合 `--duration-fast-max` 不回彈。
 * 那一套的完整理由寫在那邊,這裡不重複。
 *
 * 顏色那排最後一顆是**調色盤**:點了往下長出 `BlobPalette`(不是彈出視窗),
 * 挑的色碼存在同一個欄位;選回色票就收起來。
 *
 * ⚠️ 這個檔案是 **lazy 載入**的(見 `AccountSettingsDialog`):它拉進了 bloub 引擎,
 * 靜態 import 的話引擎會被打進主程式。右下角那隻開頁就會載入同一份引擎,
 * 所以打開設定時這塊通常已經在快取裡。
 */
import {useEffect, useRef, useState} from 'react';

import {Center} from '@astryxdesign/core/Center';
import {Stack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {ToggleButton, ToggleButtonGroup} from '@astryxdesign/core/ToggleButton';
import * as stylex from '@stylexjs/stylex';

import {
  BLOB_COLOR_LABELS,
  BLOB_COLORS,
  BLOB_SHAPE_LABELS,
  BLOB_SHAPES,
  isBlobCustomColor,
  isBlobPreset,
  isBlobShape,
  setBlobColor,
  setBlobShape,
  setLastCustomColor,
  useBlobColor,
  useBlobShape,
  useLastCustomColor,
  type BlobCustomColor,
  type BlobPreset,
  type Companion,
} from '../lib/companionPref';
import {saveBlobLook} from '../lib/loginApi';
import {BLOB_SIZE_PX, BloubAvatar, type BloubStep} from '../pet/BloubAvatar';
import {TAU} from '../pet/bloub/math';
import {closedPath} from '../pet/bloub/shape';
import {COLOR_BY_ID, SHAPE_BY_ID, type ShapeId} from '../pet/bloub/skins';
import {PET_SPRITES} from '../pet/pet-sprites';
import {BlobPalette} from './BlobPalette';

/** 換了之後開心多久 */
const CHEER_MS = 900;
const REST: BloubStep = {state: 'idle'};
const CHEER: BloubStep = {state: 'idle', expr: 'heureux'};
/** 調色盤那顆在群組裡的值(不是顏色,只是按鈕的代號) */
const CUSTOM = 'custom';
/** 調色盤挑好之後多久沒有下一筆才存帳號(方向鍵連按、色碼連打、連續放開好幾次都只送最後一筆) */
const SAVE_IDLE_MS = 400;

const styles = stylex.create({
  /*
   * 預覽台。尺寸照右下角的實際大小(Classic 的框 144px、bloub 112px),
   * 兩隻疊在同一格。⚠️ 高度寫死而不是由內容撐:兩層都是絕對定位,
   * 交叉淡入淡出時版面不能跟著跳。
   */
  stage: {
    position: 'relative',
    height: 144,
    marginBlockStart: 'var(--spacing-4)',
  },
  layer: {position: 'absolute', inset: 0},
  gif: {width: 144, height: 144, objectFit: 'contain'},
  /* ── 型態 / 顏色那塊的殼:跟 AccountSettingsDialog.actionsRow 同一套 ── */
  panel: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transition: {
      default: 'grid-template-rows var(--duration-fast-max) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  panelOpen: {
    gridTemplateRows: '1fr',
    transition: {
      default: 'grid-template-rows 420ms var(--ease-panel)',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  /** `overflow: hidden` 掛在裡面這層,grid 自己要量得到內容的完整高度(同 actionsClip) */
  clip: {overflow: 'hidden', minHeight: 0},
  /** 間距在 clip 裡面,收起來時跟著被夾掉(同 modelInner 的理由) */
  inner: {paddingBlockStart: 'var(--spacing-4)'},
  /** 調色盤跟 Color 那排的距離 = 型態 / 顏色兩列之間的距離(`VStack gap={3}`);放在 clip 裡,理由同上 */
  paletteInner: {paddingBlockStart: 'var(--spacing-3)'},
  /* ── 淡入 + 輕微回彈:跟 AccountSettingsDialog.actionsFade 同一套 ── */
  fade: {
    opacity: 0,
    scale: {default: '0.94', '@media (prefers-reduced-motion: reduce)': '1'},
    transition: {
      default: 'opacity var(--duration-fast) var(--ease-standard), scale var(--duration-fast) var(--ease-standard)',
      '@media (prefers-reduced-motion: reduce)': 'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  fadeShown: {
    opacity: 1,
    scale: '1',
    transition: {
      default: 'opacity 260ms 80ms var(--ease-standard), scale 320ms 80ms var(--ease-overshoot)',
      '@media (prefers-reduced-motion: reduce)': 'opacity var(--duration-fast) var(--ease-standard)',
    },
  },
  /** 縮起來那一層不要擋點擊(兩層疊在同一格) */
  hidden: {pointerEvents: 'none'},
  /** 調色盤鈕的圖示:一圈色相環;正在用自訂色時中間是那個顏色(⚠️ 色碼是內容資料,同 ColorIcon) */
  ring: {
    display: 'grid',
    placeItems: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    backgroundImage: 'conic-gradient(#f43f5e, #f59e0b, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #f43f5e)',
  },
  ringDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxShadow: '0 0 0 2px var(--color-background-surface)',
  },
});

/** 型態按鈕上的剪影:直接用引擎的那份半徑表畫,跟角色本身是同一個形狀 */
function ShapeIcon({id}: {id: ShapeId}) {
  const radii = SHAPE_BY_ID.get(id)?.radii ?? [];
  const n = radii.length;
  const d = closedPath(radii.map((r, i) => ({x: Math.cos((i / n) * TAU) * r * 9, y: Math.sin((i / n) * TAU) * r * 9})));
  return (
    <svg width={20} height={20} viewBox="-11 -11 22 22" aria-hidden>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/**
 * 顏色按鈕上的色點。Auto 畫成半邊 accent、半邊背景 —— 它就是「跟著佈景」。
 * ⚠️ 色碼是**內容資料**(角色的身體色,上游的調色盤),不是介面配色,
 * 跟 `dashboardChart.ts` 同一類例外。
 */
function ColorIcon({id}: {id: BlobPreset}) {
  return (
    <svg width={18} height={18} viewBox="-9 -9 18 18" aria-hidden>
      {id === 'auto' ? (
        <>
          <circle r={8} fill="var(--color-background-body)" />
          <path d="M0 -8 A8 8 0 0 0 0 8 Z" fill="var(--color-accent)" />
          <circle r={8} fill="none" stroke="var(--color-border-emphasized)" strokeWidth={1} />
        </>
      ) : (
        <circle r={8} fill={COLOR_BY_ID.get(id)?.hex} />
      )}
    </svg>
  );
}

function PaletteIcon({custom}: {custom: BlobCustomColor | null}) {
  return (
    <span {...stylex.props(styles.ring)} aria-hidden>
      {custom && <span {...stylex.props(styles.ringDot)} style={{backgroundColor: custom}} />}
    </span>
  );
}

/**
 * 調色盤挑的顏色存帳號:停 `SAVE_IDLE_MS` 沒有下一筆才送。
 * 對話框關掉(卸載)時還沒送的那一筆要送出去 —— 不送的話換一台電腦就不是這個顏色。
 */
function useIdleColorSave() {
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<BlobCustomColor | null>(null);
  const [api] = useState(() => {
    const flush = () => {
      window.clearTimeout(timer.current);
      if (pending.current) void saveBlobLook({color: pending.current});
      pending.current = null;
    };
    return {
      flush,
      schedule(hex: BlobCustomColor) {
        pending.current = hex;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, SAVE_IDLE_MS);
      },
      /** 不送了(改選色票時:見呼叫端) */
      cancel() {
        window.clearTimeout(timer.current);
        pending.current = null;
      },
    };
  });
  useEffect(() => api.flush, [api]);
  return api;
}

export default function CompanionLook({companion, isDisabled}: {companion: Companion; isDisabled?: boolean}) {
  const isBlob = companion === 'blob';
  const shape = useBlobShape();
  const color = useBlobColor();
  const lastCustom = useLastCustomColor();
  const isCustom = isBlobCustomColor(color);
  // 調色盤展開與否。打開設定時正在用自訂色 → 不自動展開,點那顆才長出來
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 換了之後開心一下。計時器要收:對話框關掉時不能留一個 setState 在路上
  const [cheer, setCheer] = useState(false);
  const cheerTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(cheerTimer.current), []);

  const customSave = useIdleColorSave();
  const celebrate = () => {
    window.clearTimeout(cheerTimer.current);
    setCheer(true);
    cheerTimer.current = window.setTimeout(() => setCheer(false), CHEER_MS);
  };

  const chooseShape = (v: string | string[] | null) => {
    // 單選群組再點一次已選的會給 null(取消選取)—— 這裡一定要有一個值,不收
    if (!isBlobShape(v) || v === shape) return;
    setBlobShape(v);
    void saveBlobLook({shape: v});
    celebrate();
  };
  const chooseColor = (v: string | string[] | null) => {
    // 點調色盤:還沒在用自訂色 → 換成上次挑的那色並展開;已經在用 → 展開 / 收起
    // (單選群組再點已選的那顆給 null,那就是「又點了調色盤」)
    if (v === CUSTOM || (v === null && isCustom)) {
      if (!isCustom) {
        setBlobColor(lastCustom);
        void saveBlobLook({color: lastCustom});
        celebrate();
        setPaletteOpen(true);
      } else {
        setPaletteOpen((o) => !o);
      }
      return;
    }
    if (!isBlobPreset(v) || v === color) return;
    // ⚠️ 還沒送的自訂色**丟掉**,不是先送出去:兩個請求同時在路上,後到的若是自訂色,
    // 帳號就停在自訂色,換一台電腦會跳回來
    customSave.cancel();
    setPaletteOpen(false);
    setBlobColor(v);
    void saveBlobLook({color: v});
    celebrate();
  };
  // 拖曳中:只換畫面(預覽、右下角那隻),不送
  const previewCustom = (hex: BlobCustomColor) => {
    setBlobColor(hex);
    setLastCustomColor(hex);
  };
  // 挑好了:換畫面、開心一下,停一下沒有下一筆才送
  const pickCustom = (hex: BlobCustomColor) => {
    previewCustom(hex);
    customSave.schedule(hex);
    celebrate();
  };
  const showPalette = isCustom && paletteOpen;

  return (
    <VStack gap={0}>
      <Stack xstyle={styles.stage} aria-hidden>
        <Center xstyle={[styles.layer, styles.fade, !isBlob && styles.fadeShown, isBlob && styles.hidden]}>
          <img src={PET_SPRITES.walking.src ?? undefined} alt="" draggable={false} {...stylex.props(styles.gif)} />
        </Center>
        <Center xstyle={[styles.layer, styles.fade, isBlob && styles.fadeShown, !isBlob && styles.hidden]}>
          <BloubAvatar
            step={cheer ? CHEER : REST}
            size={BLOB_SIZE_PX}
            follow
            baseShape={shape}
            color={color === 'auto' ? null : color}
          />
        </Center>
      </Stack>
      {/* ⚠️ 收起來時要 `inert`:按鈕還在 DOM 裡(要演完收合),不擋的話 Tab 會進到看不見的地方 */}
      <Stack xstyle={[styles.panel, isBlob && styles.panelOpen]}>
        <Stack xstyle={styles.clip} inert={!isBlob}>
          <VStack gap={3} xstyle={[styles.inner, styles.fade, isBlob && styles.fadeShown]}>
            {/* label 對報讀隱藏:群組自己帶著 `label`,不藏會被念兩次(同 Companion 那列) */}
            <VStack gap={1}>
              <Text type="label" aria-hidden>
                Shape
              </Text>
              <ToggleButtonGroup label="Shape" size="sm" value={shape} onChange={chooseShape} isDisabled={isDisabled}>
                {BLOB_SHAPES.map((s) => (
                  <ToggleButton key={s} value={s} label={BLOB_SHAPE_LABELS[s]} icon={<ShapeIcon id={s} />} isIconOnly />
                ))}
              </ToggleButtonGroup>
            </VStack>
            <VStack gap={0}>
              <VStack gap={1}>
                <Text type="label" aria-hidden>
                  Color
                </Text>
                <ToggleButtonGroup
                  label="Color"
                  size="sm"
                  value={isCustom ? CUSTOM : color}
                  onChange={chooseColor}
                  isDisabled={isDisabled}
                >
                  {[
                    ...BLOB_COLORS.map((c) => (
                      <ToggleButton key={c} value={c} label={BLOB_COLOR_LABELS[c]} icon={<ColorIcon id={c} />} isIconOnly />
                    )),
                    <ToggleButton
                      key={CUSTOM}
                      value={CUSTOM}
                      label="Custom color"
                      icon={<PaletteIcon custom={isCustom ? color : null} />}
                      isIconOnly
                    />,
                  ]}
                </ToggleButtonGroup>
              </VStack>
              {/* 調色盤:往下長出來,殼與淡入跟上面那塊同一套。間距放在 clip 裡面(`paletteInner`),
                  收起來時跟著被夾掉 —— 放在外層 VStack 的 gap 的話,收起來 Color 底下還是多一段空白 */}
              <Stack xstyle={[styles.panel, showPalette && styles.panelOpen]}>
                <Stack xstyle={styles.clip} inert={!showPalette}>
                  <Stack xstyle={[styles.paletteInner, styles.fade, showPalette && styles.fadeShown]}>
                    <BlobPalette
                      value={isCustom ? color : lastCustom}
                      onPreview={previewCustom}
                      onPick={pickCustom}
                      isDisabled={isDisabled}
                    />
                  </Stack>
                </Stack>
              </Stack>
            </VStack>
          </VStack>
        </Stack>
      </Stack>
    </VStack>
  );
}
