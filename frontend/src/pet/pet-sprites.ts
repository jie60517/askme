/**
 * 小夥伴的角色圖設定。**要換角色只要改這個檔案,不用碰任何邏輯。**
 *
 * ─────────────────────────────────────────────────────────────────────
 * 怎麼放圖
 * ─────────────────────────────────────────────────────────────────────
 * 1. 圖片放到  public/pet/  底下(Vite / CRA / Next 的 public 都一樣)
 * 2. 把對應狀態的 src 改成 "/pet/檔名"
 *    —— 開頭的斜線是必要的,那代表網站根目錄,不是專案資料夾
 * 3. 存檔即生效;build 時 public/ 會原封不動複製進 dist/
 *
 * 不想動這個檔案的話,也可以在 app 進入點用
 * `configurePet({ spriteOverrides: { ... } })` 只蓋掉要換的那幾個狀態。
 *
 * 支援 GIF / APNG / WebP(會動)與 PNG / SVG(靜態)。會動的瀏覽器自己會播。
 * 建議尺寸:內容盡量填滿畫布。這批預設圖上方約 1/3 是空白(留給道具),
 * 所以顯示區要開到 144px 角色才看得清楚(見 PetCompanion 的 size-36)。
 *
 * src 留 null 就用內建的替代圖示頂著,所以不用一次到齊,放幾張生效幾張。
 * 檔名打錯也只是那個狀態退回替代圖示,不會壞掉。
 *
 * ⚠️ 放進來的圖必須是你們有權使用的:自己畫的、自己產的、外包買斷的,
 * 或明確標示 CC0 / MIT 之類可商用的素材。詳見 src/pet/讀我.txt。
 */

import { getPetConfig } from "./petSource";

/**
 * 小夥伴的狀態。**每一個都對應系統真的送得出來的訊號**,不是隨機動作 ——
 * 這是它跟「裝飾用寵物」的差別:餘光掃過去就知道系統現在在做什麼。
 *
 * reading / searching / running 三個是從 PetTask.latestTool 推出來的。
 */
export type PetState =
  | "walking" // 閒著沒事,在畫面下緣走來走去
  | "sleeping" // 沒事而且滑鼠也很久沒動了 —— 睡著
  | "queued" // 排隊中,伺服器滿載
  | "uploading" // 附件上傳中
  | "thinking" // 已經開始跑,但還沒有任何動作
  | "reading" // 正在讀檔(latestTool = "read")
  | "searching" // 正在搜尋(latestTool = "search")
  | "running" // 正在執行指令(latestTool = "run")
  | "writing" // 正在寫回答(已經有文字吐出來)
  | "grinding" // 同一件跑超過 5 分鐘,還在跑
  | "notice" // 伺服器有提醒(例如某個附件沒上傳成功)
  | "busy2" // 同時有 2 件在跑
  | "busy3" // 同時有 capacity 件在跑(滿載)
  | "background" // 自己這頁沒事,但別的地方還在跑
  | "happy" // 剛完成
  | "stopped" // 使用者自己按了停止(跟真的失敗要分開)
  | "sad" // 剛失敗
  | "poked" // 使用者點了牠一下
  | "annoyed"; // 使用者連點很多下

export interface PetSprite {
  /** public/pet/ 底下的路徑。null = 用替代圖示 */
  src: string | null;
  /** 滑鼠移上去顯示的說明,也是給螢幕報讀軟體的描述 */
  hint: string;
}

/**
 * 預設的圖與台詞。
 *
 * 台詞是通用寫法(不綁「問答」情境)。要換成自己的用語,改這裡或用
 * configurePet({ spriteOverrides }) 都可以。
 */
export const PET_SPRITES: Record<PetState, PetSprite> = {
  /**
   * 閒著沒事就在下緣散步。
   *
   * 用 idle 而不是那組 mini-*:mini-* 是「貼在螢幕邊緣」的概念圖,角色畫得比
   * 其他張大一號,旁邊還有一條代表螢幕邊的黑色長方形 —— 放在自由浮動的框裡,
   * 會變成「走路時特別大隻、旁邊還多一塊黑」。走路的動感交給 CSS 位移就夠了。
   */
  walking: { src: "/pet/idle.gif", hint: "閒晃中,有問題就問" },

  /** 頭上有 zzz */
  sleeping: { src: "/pet/sleeping.gif", hint: "在打盹,有事再叫我" },

  /** 在等也在想 */
  queued: { src: "/pet/thinking.gif", hint: "排隊中,還沒輪到我們" },

  /** 扛著工具箱走 —— 正在把檔案搬上去 */
  uploading: { src: "/pet/carrying.gif", hint: "正在上傳你的檔案" },

  thinking: { src: "/pet/thinking.gif", hint: "正在想從哪裡查起" },

  /** 戴眼鏡看書 */
  reading: { src: "/pet/idle-reading.gif", hint: "正在讀資料" },

  /** 拿放大鏡 */
  searching: { src: "/pet/debugger.gif", hint: "正在搜尋相關檔案" },

  /** 工地帽 + 槌子 */
  running: { src: "/pet/building.gif", hint: "正在執行指令" },

  /** 上面那個終端機視窗一眼看得懂 */
  writing: { src: "/pet/typing.gif", hint: "正在寫回答" },

  /** 跑很久了還在掃 —— 這張的用意是告訴人「它沒卡住,只是很久」 */
  grinding: { src: "/pet/sweeping.gif", hint: "這件比較久,還在處理" },

  /** 伺服器有話要說(附件被略過之類的),頭上冒提示 */
  notice: { src: "/pet/notification.gif", hint: "有一則提醒,看一下訊息" },

  /** 同時 2 件在跑 —— 戴耳機進入狀況 */
  busy2: { src: "/pet/headphones-groove.gif", hint: "同時在跑 2 件" },

  /** 同時跑到上限。再來就要排隊了 */
  busy3: { src: "/pet/juggling.gif", hint: "同時跑滿了,主機滿載" },

  /** 頭上冒個對話框 —— 提醒你別的地方還在跑 */
  background: { src: "/pet/bubble.gif", hint: "另一件事還在跑" },

  happy: { src: "/pet/happy.gif", hint: "完成了!" },

  /** 被使用者按停止 —— 不是它的錯,所以用「被打斷」的表情而不是 ERROR */
  stopped: { src: "/pet/react-annoyed.gif", hint: "被你按停了" },

  /** 這張畫面上有 ERROR 字樣,不用看提示也知道 */
  sad: { src: "/pet/error.gif", hint: "這件失敗了,可以重試" },

  /**
   * 以下兩個是「使用者主動戳牠」的反應,不是系統狀態。
   *
   * 放心留著的理由:它只有在使用者自己去點的時候才會出現,不會在他工作時
   * 自己跳出來 —— 跟會自己亂動的裝飾不是同一回事。
   */
  poked: { src: "/pet/react-double-jump.gif", hint: "欸!" },
  annoyed: { src: "/pet/react-annoyed.gif", hint: "好啦好啦,別戳了" },
};

/** 取一個狀態的圖與台詞(套用 configurePet 的 spriteOverrides)。 */
export function getSprite(state: PetState): PetSprite {
  const override = getPetConfig().spriteOverrides?.[state];
  return override ? { ...PET_SPRITES[state], ...override } : PET_SPRITES[state];
}

// ───────────────────────────────────────────────────────────────────────
// 時間與門檻。這些數字都是實際用出來的,改之前先看註解為什麼是這個值。
// ───────────────────────────────────────────────────────────────────────

/** 戳一下的反應持續多久 */
export const POKE_MS = 1400;

/** 幾秒內點幾下算「一直戳」 */
export const ANNOYED_CLICKS = 4;
export const ANNOYED_WINDOW_MS = 3000;

/**
 * 滑鼠/鍵盤多久沒動就從「散步」變成「睡著」。
 *
 * 為什麼要分兩段:一直走來走去在工作畫面上會變成干擾,但完全不動又太死。
 * 人在用的時候讓牠散步、人離開就讓牠睡,是兩邊的折衷。
 */
export const SLEEP_AFTER_IDLE_MS = 60_000;

/** 跑多久算「久」。超過就換成 grinding,讓人知道它沒卡住 */
export const GRINDING_AFTER_MS = 5 * 60 * 1000;

/** happy / sad / stopped 是「剛剛發生」的狀態,顯示這麼久之後回到日常狀態 */
export const TRANSIENT_MS = 4000;

/**
 * 換圖的最短間隔。
 *
 * 工具切換非常快 —— 讀一下、搜一下、跑個指令,每次都在一兩秒內。不擋的話
 * 小夥伴會在三張圖之間瘋狂閃,比完全不動還吵,而且 GIF 每次換 src 都會從
 * 第一格重播,看起來像卡住。撐過這個時間的狀態才會真的換上去。
 */
export const MIN_STATE_MS = 1200;

/**
 * 每換一個狀態,那句台詞自己冒出來停多久。
 *
 * 這些話如果只有滑鼠移上去才看得到,等於使用者不主動去問就不存在 ——
 * 而「它現在在幹嘛」正是他最想知道的事。所以改成狀態一換就自己講。
 *
 * 3.5 秒的理由:狀態最快也要 MIN_STATE_MS(1.2 秒)才會換一次,留 3.5 秒
 * 讓短命的狀態也讀得完;真的連換好幾個時,後面那句直接蓋掉前一句。
 */
export const AUTO_SPEECH_MS = 3500;

/**
 * 每張圖的內容最上緣,在 144px 顯示框裡離框頂幾 px(object-contain 之後)。
 *
 * **一張圖一個值**:只照最高那張(happy.gif)抓一個值的話,平常最常看到的閒晃(idle.gif)
 * 內容頂端在 99px,比 happy 低了 50px,氣泡就飄在頭頂上方一大截。
 *
 * 量法:逐格解碼整張 GIF(瀏覽器的 ImageDecoder),所有影格裡第一列 alpha > 32 的像素。
 * **不能只看第一格** —— zzz、ERROR 字樣、跳起來那幾格都在後面,而氣泡也不能蓋到那些道具。
 * 畫布是 302×300(building 是 303×300),換算:框頂留白 0.5px + 列數 × 144/302。
 * ⚠️ 換一整組圖之後要重量。
 */
const SPRITE_CONTENT_TOP_PX: Record<string, number> = {
  "/pet/idle.gif": 99,
  "/pet/sleeping.gif": 67,
  "/pet/thinking.gif": 64,
  "/pet/carrying.gif": 85,
  "/pet/idle-reading.gif": 81,
  "/pet/debugger.gif": 92,
  "/pet/building.gif": 75,
  "/pet/typing.gif": 61,
  "/pet/sweeping.gif": 88,
  "/pet/notification.gif": 60,
  "/pet/headphones-groove.gif": 86,
  "/pet/juggling.gif": 73,
  "/pet/bubble.gif": 66,
  "/pet/happy.gif": 50,
  "/pet/react-annoyed.gif": 61,
  "/pet/error.gif": 65,
  "/pet/react-double-jump.gif": 54,
};

/**
 * 氣泡下緣到內容頂端留多少:箭頭往下凸約 5.7px(8px 方塊轉 45° 再往上收 4px),
 * 再留 10px 空隙。
 */
const BUBBLE_GAP_PX = 16;

/**
 * 認不得的圖(用 `configurePet({ spriteOverrides })` 換掉的)退回單一規格 ——
 * 它是照這組圖最高的那張抓的,換別的圖也不太會被蓋到。
 */
const FALLBACK_BUBBLE_DROP_PX = 28;

/** 氣泡下緣離 144px 顯示框**頂端**多遠(px),照當下那張圖的內容頂端擺。 */
export function bubbleDropPx(src: string | null): number {
  const top = src === null ? undefined : SPRITE_CONTENT_TOP_PX[src];
  return top === undefined ? FALLBACK_BUBBLE_DROP_PX : top - BUBBLE_GAP_PX;
}

// ───────────────────────────────────────────────────────────────────────
// 開關與位置(localStorage)
// ───────────────────────────────────────────────────────────────────────

/** 事件名稱固定,不跟著 storagePrefix 走 —— 它只在同一個分頁裡傳,不會跨系統打架 */
export const PET_VISIBILITY_EVENT = "pet:visibility";
export const PET_POSITION_EVENT = "pet:position";

const hiddenKey = () => `${getPetConfig().storagePrefix}_hidden`;
const positionKey = () => `${getPetConfig().storagePrefix}_pos`;

/** 位置的 localStorage key。PetCompanion 讀寫位置時用同一個來源。 */
export function petPositionKey(): string {
  return positionKey();
}

export function isPetHidden(): boolean {
  return localStorage.getItem(hiddenKey()) === "1";
}

/**
 * 開關小夥伴。
 *
 * ⚠️ 有這個函式是因為「關掉之後叫不回來」是設計疏失 —— 如果你的關閉鈕長在
 * 小夥伴身上,關掉之後那顆鈕跟著消失,使用者就沒有任何入口了。
 * 一定要在**別的地方**(指令面板、設定頁、選單)也放一個入口呼叫這裡。
 */
export function setPetHidden(hidden: boolean) {
  localStorage.setItem(hiddenKey(), hidden ? "1" : "0");
  window.dispatchEvent(new Event(PET_VISIBILITY_EVENT));
}

export function isPetPinned(): boolean {
  return localStorage.getItem(positionKey()) !== null;
}

/**
 * 解除釘住,讓牠回到右下角繼續散步。
 *
 * ⚠️ 位置存在 localStorage,重新整理、換分頁都還在。
 *
 * ⚠️ **這個 app 裡沒有呼叫端**,但**不要當成死碼刪掉** ——
 * 它跟 `isPetPinned` 都是元件包對外的 API(見 `pet-companion-kit/README.md` 與
 * `examples/3-掛進-App-與開關入口.tsx`),這份原始碼就是那個包的正本。
 *
 * 為什麼這個 app 可以沒有入口(而 `setPetHidden` **不行**,見它的檔頭):
 * 釘住的座標**永遠夾在視窗內**(`PetCompanion` 的 `readPinned` 會夾一次、
 * 拖曳當下再夾一次、視窗縮放時還會重夾),所以牠不可能被拖到抓不到的地方 ——
 * 要牠回右下角,再拖一次就是了。「藏起來」沒有這個性質:藏起來就真的不見了。
 */
export function unpinPet() {
  localStorage.removeItem(positionKey());
  window.dispatchEvent(new Event(PET_POSITION_EVENT));
}
