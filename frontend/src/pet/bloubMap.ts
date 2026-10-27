import type { BloubGaze, BloubStep } from "./BloubAvatar";
import { EXPRESSION_BY_ID, type BotExpression } from "./bloub/expressions";
import type { PetState } from "./pet-sprites";

/**
 * 小夥伴的狀態 → bloub 怎麼演。
 *
 * **對照的是 GIF 實際在做的動作**,不是狀態的名字(只看名字排的話,很多動作跟 GIF
 * 的反應根本不一樣)。這張表是逐格看過 17 張 GIF 與 bloub 的 14 段動畫之後排的,
 * 每一列的註解寫的是「GIF 在做什麼 → 用什麼去對」。
 *
 * 能用的手段有四種,**從最看得出來的排到最看不出來的**:
 *   1. bloub 自己的動畫段(`state`)—— 「…」三點、變成「!」、碎片爆開、軌道環繞;
 *   2. 身體形狀(`shape`)—— 壓扁成一條(`capsule`)最明顯;
 *   3. 外層動作(`motion`)—— 借 GIF 那邊用的那組 CSS:跳、左右搖、上下晃、垂頭、呼吸;
 *   4. 眼睛(`gaze` 腳本與 `expr` 表情)。
 * ⚠️ **表情在 112px 下很難分**(開心、大笑、生氣、驕傲都是兩條短線),
 * 所以不要讓兩個狀態只靠表情區分 —— 那樣的話好幾個狀態看起來都只是「一顆球」。
 *
 * - `then`:一次性的動畫演完停在哪(完成 → 爆開 → 開心臉)。
 * - `repeat`:一次性的動畫要不要演完再演(會一直在跑的狀態);跟 `then` 一起 = 兩段輪流。
 * - `hold`:第一段撐幾秒(被戳只有 1.4 秒,照預設 2.4 秒撐的話第二段出不來)。
 *
 * 上半段 11 列是逐一對著預覽配好的定案組合,改之前先實際看過動畫;下半段 8 列照同樣原則補齊。
 */
export interface BloubLook {
  step: BloubStep;
  then?: BloubStep;
  repeat?: boolean;
  hold?: number;
  gaze?: BloubGaze;
  /** 外層的 CSS 動作(`styles/pet.css`)。減少動態時 CSS 那邊會自己關掉 */
  motion?: "pet-sleep" | "pet-wait" | "pet-work" | "pet-cheer" | "pet-sad";
}

/**
 * 閉著眼睛的睡臉。上游最接近的 `somnolent` 是半閉(眼睛仍是兩個點),
 * 而 GIF 的睡覺是兩條橫線。沿用它的視線與間距,只把眼皮關到剩一條縫 ——
 * `open` 走的是跟眨眼同一個機制(垂直壓扁),id 留著 `somnolent` 讓眼睛位移表查得到。
 */
const ASLEEP: BotExpression = (() => {
  const base = EXPRESSION_BY_ID.get("somnolent")!;
  return {
    ...base,
    eyes: [
      { ...base.eyes[0], open: 0.1 },
      { ...base.eyes[1], open: 0.1 },
    ],
  };
})();

export const BLOUB_LOOKS: Record<PetState, BloubLook> = {
  // ── 定案的對照 ──────────────────────────────────────────────

  // 中性臉 → 看旁邊、偶爾瞄回來(眼睛腳本在兩段都生效)
  walking: { step: { state: "idle", expr: "neutre" }, then: { state: "idle", expr: "attentif" }, gaze: "away" },

  // 壓扁 + 閉眼 + 呼吸
  sleeping: { step: { state: "idle", expr: ASLEEP, shape: "capsule" }, motion: "pet-sleep" },

  // 好奇臉 → 「…」三點(三點本身會一直脈動)
  thinking: { step: { state: "idle", expr: "curieux" }, then: { state: "thinking" } },

  // 低頭一行行讀
  reading: { step: { state: "idle", expr: "attentif" }, gaze: "read", motion: "pet-sleep" },

  // 興奮臉 ↔ 抖動的「!」(寫回答會寫好幾分鐘,兩段輪流)
  writing: { step: { state: "idle", expr: "excite" }, then: { state: "alert" }, repeat: true },

  // 六角形 + 敲打節奏
  grinding: { step: { state: "hexagon" }, motion: "pet-work" },

  // 冒通知點
  notice: { step: { state: "notify" } },

  // 興奮臉 → 軌道環繞。結果只顯示 4 秒(TRANSIENT_MS),第一段縮到 1 秒,環才演得完
  happy: { step: { state: "idle", expr: "excite" }, then: { state: "orbit" }, hold: 1 },

  // 縮成小點彈跳 ↔ 彗星(執行指令會跑很久,兩段輪流)
  running: { step: { state: "sleep" }, then: { state: "comet" }, repeat: true },

  // 害羞 → 變成「!」。反應只有 1.4 秒(POKE_MS),害羞撐 0.45 秒,「!」才來得及變出來
  poked: { step: { state: "idle", expr: "timide" }, then: { state: "exclaim" }, hold: 0.45 },

  // 困惑 → 無奈。同上,1.4 秒內要看得到後面那張臉
  annoyed: { step: { state: "idle", expr: "confus" }, then: { state: "idle", expr: "blase" }, hold: 0.6 },

  // ── 其餘的狀態 ────────────────────────────────────
  // 原則:不用上面已經配給別的事件的素材(不然兩件事看起來一樣)。

  // thinking.gif(跟「思考」同一張):頭上冒「…」→ 同樣是「…」三點,但不先擺好奇臉,
  // 改成左右輕搖 —— 排隊是在等,不是在想
  queued: { step: { state: "thinking" }, motion: "pet-wait" },

  // carrying.gif:扛箱子往前搬 →「▶」三角形 + 彩帶掃過(東西被送出去),加吃力的上下晃
  uploading: { step: { state: "play" }, repeat: true, motion: "pet-work" },

  // debugger.gif:拿放大鏡探頭找 → 歪頭左右張望 ↔ 眨一眼(瞇眼湊近鏡片看),兩段輪流
  searching: {
    step: { state: "idle", expr: "curieux" },
    then: { state: "wink" },
    repeat: true,
    gaze: "scan",
  },

  // headphones-groove.gif:閉眼享受、頭抬起來左右搖 → 得意的瞇眼(往上看的弧線)+ 左右搖
  busy2: { step: { state: "idle", expr: "fier" }, motion: "pet-wait" },

  // juggling.gif:三顆球在頭上亂飛 → 碎片爆開再長回來(東西滿天飛),演完再演 + 手忙腳亂的晃
  busy3: { step: { state: "burst" }, repeat: true, motion: "pet-work" },

  // bubble.gif:注意力在別處 → 瞪大眼往右上看(看著那邊的事)
  background: { step: { state: "wide" } },

  // react-annoyed.gif:愣一下再翻白眼 → 驚訝 → 無奈
  stopped: { step: { state: "idle", expr: "surpris" }, then: { state: "idle", expr: "blase" }, hold: 1 },

  // error.gif:嚇到、癱掉 → 害怕的大眼 → 洩氣成一滴淚的形狀 + 難過臉 + 往一邊垂
  sad: {
    step: { state: "idle", expr: "effraye" },
    then: { state: "idle", expr: "triste", shape: "goutte" },
    hold: 0.8,
    motion: "pet-sad",
  },
};
