/**
 * 右下角的吉祥物,兩隻讓使用者在個人設定裡選。
 *
 * - `classic`:GIF 版的小夥伴(`public/pet/*.gif`)
 * - `blob`:bloub(`src/pet/BloubAvatar.tsx`,狀態對應在 `src/pet/bloubMap.ts`)
 *
 * 選 Bloub 的人還可以挑**型態**與**顏色**。
 * 選 Classic 時這兩個值照樣記著 —— 切回 Bloub 還是剛剛那個樣子。
 *
 * 跟 `modelPref.ts` 同一套分工:localStorage 負責「這台電腦一打開就是這隻」——
 * 小夥伴掛載時同步讀得到,不會先閃一下舊的那隻再換;伺服器那份負責「換一台電腦也一樣」,
 * 登入後 `adoptServer*()` 採用一次。
 *
 * ⚠️ **沒設過是 classic**,想換的人自己來設定裡切。型態 / 顏色沒設過是**圓形 + auto**。
 */
import {useSyncExternalStore} from 'react';

import type {ColorId, ShapeId} from '../pet/bloub/skins';
import {isHexColor, type HexColor} from './hsv';
import {readString, writeString} from './safeStorage';

/**
 * 一個「本機先套、伺服器之後追上」的單選偏好。三項(吉祥物 / 型態 / 顏色)長得一模一樣,
 * 寫一次就好 —— 抄三份的話遲早有一份漏了「不認得的值不採用」。
 */
function choiceStore<T extends string>(key: string, accept: (v: unknown) => v is T, fallback: T) {
  let current: T = (() => {
    const v = readString(key);
    return accept(v) ? v : fallback;
  })();
  const listeners = new Set<() => void>();
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  const put = (next: T) => {
    if (next === current) return;
    current = next;
    writeString(key, next);
    for (const l of listeners) l();
  };
  return {
    /** 使用者在個人設定裡改了。只套本機 —— 送伺服器是呼叫端的事。 */
    set: put,
    /** 目前的值,一變就重畫(模組變數改了不會讓元件重繪,所以走 useSyncExternalStore)。 */
    use: (): T => useSyncExternalStore(subscribe, () => current),
    /**
     * 採用伺服器上那份(`/api/me` 回來時)。
     *
     * ⚠️ 不寫回伺服器(跟 `adoptServerModel` 同一個坑);`null`(沒設過)不動本機那份;
     * 不認得的值(伺服器比前端新、多了一個選項)也不動 —— 畫不出來的不能採用。
     */
    adopt: (value?: string | null) => {
      if (accept(value)) put(value);
    },
  };
}

const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    (list as readonly unknown[]).includes(v);

// ── 吉祥物 ────────────────────────────────────────────────────────────

export type Companion = 'classic' | 'blob';

export const COMPANIONS: readonly Companion[] = ['classic', 'blob'];

export const COMPANION_DEFAULT: Companion = 'classic';

/**
 * 設定裡那排的字。介面語言是英文;第二隻照原作叫 **Bloub**。
 * ⚠️ 存在帳號裡的值是 `blob`,跟顯示的字不一樣 —— 不要跟著改(改了等於要遷移)。
 */
export const COMPANION_LABELS: Record<Companion, string> = {
  classic: 'Classic',
  blob: 'Bloub',
};

/** 認得的值才算 —— 跟 `COMPANIONS` 同一份清單,加一隻只改上面那一處(標籤表的型別會逼你補字) */
export const isCompanion = oneOf(COMPANIONS);

const companion = choiceStore('t100_companion', isCompanion, COMPANION_DEFAULT);
export const setCompanion = companion.set;
export const useCompanion = companion.use;
export const adoptServerCompanion = companion.adopt;

// ── Bloub 的型態 ──────────────────────────────────────────────────────

/**
 * 值是上游引擎的 id(`pet/bloub/skins.ts` 的 `SHAPES`,法文),後端白名單
 * `users.COMPANION_SHAPES` 是同一份 —— 加減要兩邊一起改。
 */
export const BLOB_SHAPES: readonly ShapeId[] = [
  'cercle',
  'galet',
  'squircle',
  'capsule',
  'triangle',
  'hexagone',
  'nuage',
  'goutte',
];

export const BLOB_SHAPE_DEFAULT: ShapeId = 'cercle';

/** 只給報讀(畫面上是剪影,不放字) */
export const BLOB_SHAPE_LABELS: Record<ShapeId, string> = {
  cercle: 'Circle',
  galet: 'Pebble',
  squircle: 'Squircle',
  capsule: 'Capsule',
  triangle: 'Triangle',
  hexagone: 'Hexagon',
  nuage: 'Cloud',
  goutte: 'Drop',
};

export const isBlobShape = oneOf(BLOB_SHAPES);

const blobShape = choiceStore('t100_companion_shape', isBlobShape, BLOB_SHAPE_DEFAULT);
export const setBlobShape = blobShape.set;
export const useBlobShape = blobShape.use;
export const adoptServerBlobShape = blobShape.adopt;

// ── Bloub 的顏色 ──────────────────────────────────────────────────────

/**
 * `auto` = 跟著佈景(淺色近黑、深色近白),也是沒設過的樣子。
 * 上游的 `encre`(近黑)與 `creme`(近白)**刻意不收**:那就是 auto 在兩種佈景下的樣子,
 * 而且各在一種佈景裡幾乎看不見(深色畫面上的黑色身體)。
 */
export type BlobPreset = 'auto' | Exclude<ColorId, 'encre' | 'creme'>;

/**
 * 調色盤自己挑的顏色:`#rrggbb`,一律小寫。後端 `users._pick_color` 同一條規則。
 * ⚠️ 只收這一種寫法 —— 它直接變成 SVG 的 fill。
 */
export type BlobCustomColor = HexColor;

export type BlobColor = BlobPreset | BlobCustomColor;

/** 色票那幾顆(不含調色盤) */
export const BLOB_COLORS: readonly BlobPreset[] = [
  'auto',
  'gris',
  'brun',
  'rouge',
  'orange',
  'ambre',
  'vert',
  'turquoise',
  'bleu',
  'violet',
  'rose',
];

export const BLOB_COLOR_DEFAULT: BlobColor = 'auto';

/** 只給報讀(畫面上是色點,不放字) */
export const BLOB_COLOR_LABELS: Record<BlobPreset, string> = {
  auto: 'Auto',
  gris: 'Gray',
  brun: 'Brown',
  rouge: 'Red',
  orange: 'Orange',
  ambre: 'Amber',
  vert: 'Green',
  turquoise: 'Teal',
  bleu: 'Blue',
  violet: 'Violet',
  rose: 'Pink',
};

export const isBlobPreset = oneOf(BLOB_COLORS);

export const isBlobCustomColor = isHexColor;

export const isBlobColor = (v: unknown): v is BlobColor => isBlobPreset(v) || isBlobCustomColor(v);

const blobColor = choiceStore('t100_companion_color', isBlobColor, BLOB_COLOR_DEFAULT);
export const setBlobColor = blobColor.set;
export const useBlobColor = blobColor.use;
export const adoptServerBlobColor = blobColor.adopt;

/**
 * 上一次在調色盤挑的顏色。只記在這台電腦 —— 用途只是「挑了色票之後再點調色盤,回到上次那一色」;
 * 真正在用的顏色是上面那一份(會存帳號)。
 */
const lastCustom = choiceStore<BlobCustomColor>('t100_companion_custom', isBlobCustomColor, '#3b93f0');
export const setLastCustomColor = lastCustom.set;
export const useLastCustomColor = lastCustom.use;
