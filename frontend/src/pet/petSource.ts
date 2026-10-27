/**
 * 小夥伴的「訊號來源」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這個檔案是整包唯一要你動手接線的地方。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 小夥伴不自己去打 API,也不知道你的專案怎麼跑任務 —— 它只問三件事:
 *
 *   1. 使用者現在看的這一頁,有沒有一件正在跑的工作?(getCurrentTask)
 *   2. 全站總共有幾件在跑?(getActiveCount)
 *   3. 有變化時通知我。(subscribe)
 *
 * 你把這三個接上自己的狀態(Redux / Zustand / 自己寫的 store / SSE 都行),
 * 剩下的狀態機、動畫、氣泡、拖曳、無障礙全部是現成的。
 *
 * 這個專案的接法在 `lib/petSetup.tsx`(kit 另附 `pet-companion-kit/examples/2-本專案的接法.ts`),
 * 那是一份可以照抄的實例。
 */

import type * as React from "react";

import type { ColorId, ShapeId } from "./bloub/skins";
import type { PetState } from "./pet-sprites";

/**
 * 工作目前用到的工具種類。
 *
 * 只分四類是刻意的 —— 圖只有這幾張,而且使用者要的是「它在幹嘛」的粗略手感,
 * 不是工具名稱的忠實轉播。你的後端工具集變了也不用改這裡,對應不到就給 "other"。
 */
export type PetTool = "read" | "search" | "run" | "other";

/**
 * 一件正在跑(或剛跑完)的工作。
 *
 * `id` / `startedAt` / `done` / `success` 是**必填**的(狀態機少了它們就推不動);
 * 其餘的訊號有多少給多少,沒給的那個狀態就不會出現。
 */
export interface PetTask {
  /**
   * 這一件工作的識別碼。
   *
   * ⚠️ 用來判斷「這是不是同一件」—— 結束時的 happy / sad 表情靠它去重,
   * 沒有它的話同一件工作會被重複觸發表情。整個生命週期內不可以變。
   */
  id: string | number;

  /** 送出的時間戳(Date.now())。用來判斷「跑很久了」。 */
  startedAt: number;

  /** 還在排隊、還沒真的開始跑 */
  queued?: boolean;

  /** 正在上傳附件 */
  uploading?: boolean;

  /** 伺服器的提醒(例如某個附件沒上傳成功)。有東西就會蓋過動作狀態。 */
  notices?: string[];

  /** 最近一次用到的工具。給了才會出現 reading / searching / running。 */
  latestTool?: PetTool;

  /** 已經開始把結果吐出來了(有文字了)。優先於 latestTool。 */
  streaming?: boolean;

  /** 跑完了沒 */
  done: boolean;

  /** done 之後才有意義:成功 or 失敗 */
  success: boolean;

  /**
   * 失敗訊息。預設規則:開頭是「已停止」就當成「使用者自己按停止」,
   * 給 stopped 表情而不是 sad —— 那是他自己的決定,不該給他看 ERROR。
   * 你的訊息長不一樣的話,改 configurePet({ isStoppedByUser }) 就好。
   */
  error?: string | null;
}

export interface PetSource {
  /**
   * 使用者現在看的這一頁對應的工作。沒有就回 undefined。
   *
   * ⚠️ 這裡要回的是「**現在這個畫面**的那一件」,不是「最新的那一件」。
   * 小夥伴是跨頁常駐的,使用者切去看別的地方時,牠要能分辨
   * 「我這頁沒事,但別的地方還在跑」(background 狀態)。
   *
   * ⚠️ 剛送出的那一瞬間要查得到。網址還沒更新就用網址當 key 的話,
   * 自己剛送出的那一題查不到,被誤判成「別組還在跑」,而且因為換圖節流
   * 被鎖住 1.2 秒 —— 使用者一定看得到那個錯誤狀態。
   */
  getCurrentTask(): PetTask | undefined;

  /** 全站(所有頁面 / 所有對話)目前還在跑的工作數。用來推 busy2 / busy3 / background。 */
  getActiveCount(): number;

  /** 任何一件工作有動靜就呼叫 cb。回傳退訂函式。 */
  subscribe(cb: () => void): () => void;
}

/** 還沒接線時的預設值:永遠沒事做 —— 小夥伴會散步、會睡覺,不會壞掉。 */
const IDLE_SOURCE: PetSource = {
  getCurrentTask: () => undefined,
  getActiveCount: () => 0,
  subscribe: () => () => {},
};

let source: PetSource = IDLE_SOURCE;

/**
 * 接上你的訊號來源。**要在 <PetCompanion /> 掛上去之前呼叫**(通常放在
 * app 進入點的模組層級,或是 main.tsx 最上面)。
 */
export function configurePetSource(next: PetSource) {
  source = next;
}

export function getPetSource(): PetSource {
  return source;
}

// ───────────────────────────────────────────────────────────────────────
// 其餘可調的東西
// ───────────────────────────────────────────────────────────────────────

export interface PetConfig {
  /** 顯示名稱。只出現在無障礙標籤(「小夥伴:正在讀程式碼(可以拖著移動)」)。 */
  name: string;

  /**
   * 幾件同時在跑算「滿載」。這個專案的後端上限是 3(`MAX_CONCURRENT_ASKS`)。
   * 到達這個數字用 busy3 的圖,少一件用 busy2。
   */
  capacity: number;

  /**
   * localStorage key 的前綴(`{prefix}_hidden` / `{prefix}_pos`)。
   * 同一個網域下跑兩套系統時要分開,不然存起來的開關/位置會互相蓋掉。
   *
   * ⚠️ **自訂事件的名稱不跟著這個前綴走** —— `PET_VISIBILITY_EVENT` /
   * `PET_POSITION_EVENT` 是寫死的常數(見 `pet-sprites.ts`),因為它們只在
   * 同一個分頁裡傳。同一個分頁裡真的掛了兩套的話,兩套會收到對方的顯示/位置
   * 事件,改前綴擋不住這件事。
   */
  storagePrefix: string;

  /** 圖載不到時退回顯示的東西。預設是一個內建的小圓標。 */
  fallbackIcon?: React.ReactNode;

  /**
   * 氣泡帶連結時怎麼跳。
   *
   * 預設是普通的 <a href>(整頁重新載入)。用 react-router 的話傳:
   *   renderLink: (href, children, onClick) => <Link to={href} onClick={onClick}>{children}</Link>
   */
  renderLink?: (
    href: string,
    children: React.ReactNode,
    onClick: () => void,
  ) => React.ReactNode;

  /**
   * 這次結束算不算「使用者自己按停止」。拿到的是 PetTask.error。
   * 預設看開頭是不是「已停止」。
   */
  isStoppedByUser?: (error: string | null | undefined) => boolean;

  /** 想整組換掉台詞/圖時用。只覆蓋你給的那幾個狀態,其餘沿用預設。 */
  spriteOverrides?: Partial<Record<PetState, { src?: string | null; hint?: string }>>;

  /**
   * 這一刻要不要改畫 bloub(會變形的那團,見 `BloubAvatar.tsx`)而不是圖。
   *
   * **它是一個 React hook**,`<PetCompanion />` 每次重繪都會呼叫 —— 使用者在設定裡
   * 一切換,牠當場換掉。所以要傳一支穩定的函式、裡面照 hook 的規矩寫
   * (例如 `() => useCompanion() === "blob"`)。不給 = 永遠畫圖。
   *
   * 只換「畫面那一層」:狀態、台詞、拖曳、戳、氣泡全部共用。
   */
  useBlob?: () => boolean;

  /**
   * bloub 的身體形狀與顏色(使用者在個人設定挑的)。跟 `useBlob` 一樣**是 hook**,
   * 每次重繪都會呼叫。不給 = 圓形 + 跟著佈景。
   * `color` 給 `null` = 跟著佈景(淺色近黑、深色近白);色票的 id 或調色盤挑的 `#rrggbb`。
   */
  useBlobLook?: () => { shape?: ShapeId; color?: ColorId | `#${string}` | null };
}

const DEFAULT_CONFIG: PetConfig = {
  name: "小夥伴",
  capacity: 3,
  storagePrefix: "pet",
};

let config: PetConfig = DEFAULT_CONFIG;

/** 改設定。可以只給要改的那幾項。 */
export function configurePet(partial: Partial<PetConfig>) {
  config = { ...config, ...partial };
}

export function getPetConfig(): PetConfig {
  return config;
}
