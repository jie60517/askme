import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

import { createPointerOwner } from "../lib/pointerOwner";
import { cn } from "./cn";
import {
  TOOLTIP_ARROW_TOP_CLASS,
  TOOLTIP_PANEL_CLASS,
  TOOLTIP_SPRING,
  useTooltipWobble,
} from "./tooltip-panel";
import {
  ANNOYED_CLICKS,
  ANNOYED_WINDOW_MS,
  AUTO_SPEECH_MS,
  SLEEP_AFTER_IDLE_MS,
  GRINDING_AFTER_MS,
  MIN_STATE_MS,
  POKE_MS,
  PET_POSITION_EVENT,
  PET_VISIBILITY_EVENT,
  TRANSIENT_MS,
  bubbleDropPx,
  getSprite,
  isPetHidden,
  petPositionKey,
  type PetState,
} from "./pet-sprites";
import { PET_SPEAK_EVENT, SPEECH_MS, type PetSpeech } from "./petSpeech";
import { getPetConfig, getPetSource, type PetConfig, type PetTask, type PetTool } from "./petSource";
import { BLOB_SIZE_PX, BloubAvatar } from "./BloubAvatar";
import { BLOUB_LOOKS } from "./bloubMap";
import {
  PET_EXIT_DURATION_TOKEN,
  PET_EXIT_EASE_TOKEN,
  PET_EXIT_FALLBACK_EASE,
  PET_EXIT_FALLBACK_MS,
  durationTokenMs,
  easeTokenBezier,
  easeTokenCss,
} from "./motionTokens";
import { usePetWander } from "./usePetWander";
import { useReducedMotion } from "./useReducedMotion";

/** 沒設定 `useBlob` 時的預設:永遠畫圖 */
const NEVER_BLOB = () => false;
/** 沒設定 `useBlobLook` 時的預設:圓形 + 跟著佈景 */
const PLAIN_LOOK: NonNullable<PetConfig["useBlobLook"]> = () => ({});


/**
 * bloub 的氣泡下緣離 144px 框頂多遠。球頂在框頂往下約 37px((144 − 112×0.63) / 2)。
 * 跟圖不同,bloub 不分狀態用同一個高度。
 *
 * 用 18 不用 30:30 的時候箭頭尖端(下緣再往下約 5.7px)離球頂只剩約 1px,戳一下身體往上拉長、
 * 或 pet-cheer 往上跳 10px 時就直接頂到。18 留約 12px。
 */
const BLOB_BUBBLE_DROP_PX = 18;

/**
 * 畫面右下角的小夥伴。
 *
 * **它不是裝飾,是一個狀態指示器。** 一件工作跑 3~15 分鐘時,中間畫面幾乎是
 * 靜止的 —— 進度條和文字解決的是「資訊」(它在做什麼),這隻解決的是
 * 餘光掃過去就知道「它還活著」。
 *
 * 所以它的動作一律對應真實狀態,不做隨機動作:
 *   打瞌睡 → 排隊 → 翻資料 → 完成了 / 失敗了
 *
 * 角色圖在 pet-sprites.ts,換圖不用動這個檔案。
 * 訊號從哪來在 petSource.ts,那是唯一要接線的地方。
 *
 * ⚠️ **這份與 pet-companion-kit 已經分家,以這個 repo 的 `src/pet/` 為正本。**
 * 要整包覆蓋升級 kit 的話,下面這幾處本地修改要帶過去(或確認 kit 已經有):
 *   - 拖曳的多點觸控保護 —— 走宿主的 `lib/pointerOwner.ts`(⚠️ kit 本來不 import 宿主程式碼,
 *     這是例外;要搬回 kit 就把那支一起帶走);
 *   - 拖曳中只寫外層的 transform,放手才 `setPinned` + 存檔(見 `usePetDrag`);
 *   - 氣泡進場從 scale 0.92 長出來,退場走 `--duration-fast-max` + `--ease-standard`
 *     (不走 framer 預設的彈簧;token 由 `motionTokens.ts` 讀);
 *   - pet-sad / pet-wait 拿掉時用 Web Animations 從當下的角度回正,不會「啪」一下(`useSettleBack`);
 *   - `BloubAvatar.tsx` 每一格直接寫 DOM(`paintBloubSvg`),見那個檔頭。
 *
 * @param viewKey 目前這一頁的識別(通常是 location.pathname)。
 *   只是用來讓「換頁」這件事觸發重新計算 —— 小夥伴是跨頁常駐的,
 *   使用者切到別頁時牠要立刻改判「我這頁沒事,但別的地方還在跑」。
 *   沒有 router 的專案不給也可以。
 */
export default function PetCompanion({ viewKey }: { viewKey?: string } = {}) {
  const realState = usePetState(viewKey);
  const { speech, dismiss } = useSpeech();
  const { reaction, poke } = usePoke();
  // 外層容器(位移層)。散步(usePetWander)與拖曳(usePetDrag)都直接寫它的 transform,見兩邊的說明
  const moveRef = useRef<HTMLDivElement>(null);
  const { pinned, dragging, didDrag, handlers } = usePetDrag(moveRef);
  const config = getPetConfig();
  // ⚠️ 這是 hook(見 PetConfig.useBlob),一定要在任何 return 之前、每次都呼叫
  const blob = (config.useBlob ?? NEVER_BLOB)();
  // 同上,也是 hook:使用者挑的形狀與顏色
  const look = (config.useBlobLook ?? PLAIN_LOOK)();

  // 戳的反應蓋過一般狀態,但**蓋不過結果** —— 剛完成/剛失敗的時候
  // 要讓人看到結果,不是看牠在跳
  const resultState =
    realState === "happy" || realState === "sad" || realState === "stopped";
  // 說話時的表情由通報方指定(例如共用用 happy)。它蓋過戳的反應,
  // 但一樣蓋不過結果。
  const state =
    speech?.state && !resultState
      ? speech.state
      : reaction && !resultState
        ? reaction
        : realState;
  const sprite = getSprite(state);

  // 狀態一換就自己講那句;滑鼠移到牠身上(或鍵盤 Tab 到牠身上)則是隨時問得到
  // 「你現在在幹嘛」。兩個旗標要分開記:滑過去再點一下,焦點還在牠身上,
  // 這時把滑鼠移開不該讓字消失。
  const autoVisible = useAutoSpeech(state);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const wobble = useTooltipWobble();

  // 氣泡只有一個,內容三選一。
  //
  // 通報(petSay 送進來的)優先 —— 那是別人找你,比「牠自己在做什麼」重要,
  // 而且只有它帶得了連結。其餘時候就講目前狀態那一句。
  //
  // notice 分開記是給無障礙用的:通報要當成即時訊息念出來(role=status),
  // 狀態那句不行 —— 它每一兩秒就換一次,報讀軟體會整天在唸「正在讀資料、
  // 正在搜尋…」,而那句話按鈕的 aria-label 裡本來就有。
  const bubble: { text: string; href?: string; notice: boolean } | null = speech
    ? { text: speech.text, href: speech.href, notice: true }
    : hovered || focused || autoVisible
      ? { text: sprite.hint, notice: false }
      : null;

  // 開關狀態由 pet-sprites 的 setPetHidden 統一寫入,你的指令面板/設定頁也是
  // 呼叫同一個函式,所以這裡只負責跟著事件重讀 —— 兩個入口不會各記一份而對不起來
  const [hidden, setHidden] = useState(isPetHidden);

  useEffect(() => {
    const sync = () => setHidden(isPetHidden());
    window.addEventListener(PET_VISIBILITY_EVENT, sync);
    return () => window.removeEventListener(PET_VISIBILITY_EVENT, sync);
  }, []);

  // 載不到的圖記下來,那個狀態就退回替代圖示。
  //
  // 這件事很重要:設定檔可以先把路徑都填好、圖之後再慢慢放進去。
  // 少了這段,還沒放圖的狀態會變成一個空白圓圈(圖載不到又沒有替代),
  // 使用者會以為小夥伴壞了。
  const [brokenSrc, setBrokenSrc] = useState<Set<string>>(new Set());
  const src = sprite.src;
  // bloub 不用圖,也就沒有「圖載不到」這回事
  const useFallback = !blob && (!src || brokenSrc.has(src));

  // 走多遠、往哪走:可以去的範圍(相對家的位移)。
  //
  // 預設在右下角,往左一定夠。被拖到左邊時就得看剩多少空間 —— 只夾不換方向的話,
  // 拖到最左邊會變成距離 0,牠只會原地踏步。所以左邊不夠就改往右走。
  const walkRange = ((): [number, number] => {
    if (!pinned) return [-WALK_MAX_PX, 0];
    const toLeft = Math.min(WALK_MAX_PX, Math.max(0, pinned.x));
    if (toLeft >= WALK_MIN_PX) return [-toLeft, 0];
    const toRight = Math.min(WALK_MAX_PX, Math.max(0, window.innerWidth - PET_SIZE_PX - pinned.x));
    return toRight >= WALK_MIN_PX ? [0, toRight] : [-toLeft, 0];
  })();

  // 閒著的時候逛一逛(不翻面、隨機挑點、
  // 小夥伴用跳的、bloub 果凍滑行與滾動輪流;見 petWander.ts)。
  //
  // 位移一定要放在**最外層**(moveRef):氣泡與滑鼠感應區要跟著走 —— 放在按鈕上的話,
  // 牠走到旁邊了,滑鼠移到牠**原本**的位置反而會跳出說明。
  // 跳、傾斜、壓扁放在角色那一層(bodyRef):氣泡不在裡面,字才不會跟著歪。
  //
  // 什麼時候停:不是閒晃狀態(停在原地開始做事,回到閒晃時從原地接著逛)、
  // 滑鼠指著牠或鍵盤焦點在牠身上(氣泡的位置是打開那一刻算的,牠一走就跟氣泡分家)、
  // 正在拖、開了減少動態。
  //
  // ⚠️ **被拖的那一刻位移要歸零**(resetKey = dragging):拖曳的起點是 pointerdown 量到的
  // getBoundingClientRect(),**含**散步當下的位移,接著 setPinned 把牠釘在那個座標 ——
  // 位移不歸零的話,釘好的座標會再被推開一次。
  const bodyRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  // bloub 的外層動作逐個狀態挑過(跳、搖、垂頭…),不是整組沿用 GIF 那一套 ——
  // 它自己會變形,有些狀態再疊一層晃動就是兩層動作。見 bloubMap.ts
  const motionClass = useSettleBack(
    blob ? BLOUB_LOOKS[state].motion : STATE_ANIMATION[state],
    buttonRef,
    reducedMotion,
  );
  // 氣泡退場的時間與曲線:設計 token,掛上時讀一次(framer 吃不了 var(--…),見 motionTokens.ts)
  const [exitTransition] = useState(() => ({
    duration: durationTokenMs(PET_EXIT_DURATION_TOKEN, PET_EXIT_FALLBACK_MS) / 1000,
    ease: easeTokenBezier(PET_EXIT_EASE_TOKEN, PET_EXIT_FALLBACK_EASE),
  }));
  const strolling = state === "walking";
  const lookXRef = usePetWander(
    blob ? "blob" : "hop",
    walkRange,
    strolling && !dragging && !hovered && !focused && !reducedMotion && !hidden,
    dragging,
    moveRef,
    bodyRef,
  );

  if (hidden) return null;

  const bubbleText = bubble?.text ?? "";

  return (
    <div
      className={cn(
        // hidden md:block:手機上不顯示。小螢幕本來就沒有多餘的空間放一隻
        // 會動的東西,而且拖曳在觸控上會跟捲動打架。
        "fixed z-40 hidden select-none md:block",
        // 沒被拖過就用預設的右下角(bottom-28 是為了避開輸入框那一排)
        !pinned && "bottom-28 right-4",
      )}
      ref={moveRef}
      style={pinned ? { left: pinned.x, top: pinned.y } : undefined}
    >
      <div className="relative">
        {/* 說話氣泡。放在 relative 這層而不是按鈕裡面 —— 按鈕有 rounded-full
            跟固定尺寸,氣泡塞進去會被裁掉。

            **牠只有這一個氣泡。** 同一隻角色頭上冒出來的框長得不一樣,
            看起來就像兩個不同的東西。 */}
        {/* 外面這層只管「擺在哪」與置中,晃動交給裡面那層 ——
            framer 的 x/rotate 會直接寫 inline transform,跟 -translate-x-1/2
            疊在同一個元素上會把置中蓋掉(氣泡整個偏到右邊去)。 */}
        <div
          aria-hidden={!bubble}
          // 氣泡下緣離 144px 顯示框頂端多遠。圖是一張一個值,照那張的內容頂端擺
          // (見 pet-sprites 的 bubbleDropPx);換圖時滑過去,不要一格跳 ——
          // 狀態最快 MIN_STATE_MS 才換一次,滑動不會疊在一起。減少動態就直接換。
          // 退回替代圖示時那張是滿版的,就貼在框上緣。
          style={{
            bottom: useFallback
              ? "calc(100% + 0.625rem)"
              : blob
                ? `calc(100% - ${BLOB_BUBBLE_DROP_PX}px)`
                : `calc(100% - ${bubbleDropPx(src)}px)`,
            transition: reducedMotion
              ? undefined
              : "bottom var(--duration-medium-min, 225ms) var(--ease-standard, ease-out)",
          }}
          className="absolute left-1/2 z-50 -translate-x-1/2"
        >
          <AnimatePresence mode="wait">
            {bubble && (
              <motion.div
                // 刻意**不給 key**:給了的話每換一句都要先退場再進場(mode="wait"),
                // 而狀態台詞一兩秒就換一次,等退場等於每次都慢半拍。
                // 「冒出來/收回去」有動畫,中間換字直接換。
                role={bubble.notice ? "status" : "tooltip"}
                // 進場從 0.92 長出來:起點再小(例如 0.85)加上彈簧,一句台詞冒出來像是彈出來的
                initial={wobble.reduced ? false : { opacity: 0, y: 8, scale: 0.92 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  transition: wobble.reduced
                    ? { duration: 0 }
                    : { type: "spring", ...TOOLTIP_SPRING },
                }}
                // 退場給明確的時間與曲線(`--duration-fast-max` + `--ease-standard`):沒給的話走
                // framer 預設 —— 約 0.3 秒、y 還是彈簧會彈一下,收回去比冒出來還慢。退場要比進場快,而且不彈
                exit={
                  wobble.reduced
                    ? { opacity: 0, transition: { duration: 0 } }
                    : { opacity: 0, y: 6, scale: 0.9, transition: exitTransition }
                }
                style={{ rotate: wobble.rotate, x: wobble.x }}
                className={cn(
                  "w-max max-w-64 origin-bottom [transform-style:preserve-3d]",
                  TOOLTIP_PANEL_CLASS,
                )}
              >
                {bubble.href ? (
                  config.renderLink ? (
                    config.renderLink(bubble.href, bubbleText, dismiss)
                  ) : (
                    <a
                      href={bubble.href}
                      onClick={dismiss}
                      className="underline-offset-2 hover:underline"
                    >
                      {bubbleText}
                    </a>
                  )
                ) : (
                  bubbleText
                )}
                {/* 指向角色的小尖角,跟提示泡泡共用同一個 class */}
                <span aria-hidden="true" className={TOOLTIP_ARROW_TOP_CLASS} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {/* 散步時的跳、傾斜、壓扁、滾動**只動角色這一層**(usePetWander 直接寫 transform)。
            氣泡是上面那個兄弟節點,不在這層裡面,所以字不會跟著歪、跟著轉。

            為什麼要多包一層而不是掛在按鈕上:按鈕的 transform 已經被 STATE_ANIMATION 佔用了
            (pet-sleep / pet-wait / pet-work 那組 CSS 動畫),inline transform 會跟它打架。 */}
        <div ref={bodyRef} className="flex">
          <button
            ref={buttonRef}
            type="button"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            {...handlers}
            // 拖動過就不要再觸發「戳」的反應 —— 使用者是在搬牠,不是在戳牠
            onClick={() => {
              if (!didDrag()) poke();
            }}
            // 鍵盤 Tab 到牠身上也要看得到那句話 —— 只認滑鼠的話,用鍵盤的人
            // 永遠看不到
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              wobble.reset();
            }}
            aria-label={`${config.name}:${sprite.hint}(可以拖著移動)`}
            className={cn(
              "relative flex touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
              dragging ? "cursor-grabbing" : "cursor-grab",
              // 用圖時放到 144px:這批圖的角色只佔畫布寬度 33~42%
              //(上方有近 1/3 是空白,留給終端機視窗、ERROR 字樣那些道具),
              // 所以顯示框要開得比角色實際想要的尺寸大很多才看得清楚。
              // 退回替代圖示時維持 64px 的圓形徽章,那張是滿版的不需要留白。
              useFallback ? "size-16 rounded-full bg-muted/60 backdrop-blur" : "size-36",
              // 狀態動畫(pet-sleep / pet-wait…),見上面的 useSettleBack
              motionClass,
            )}
          >
            {blob ? (
              <BloubAvatar
                step={BLOUB_LOOKS[state].step}
                then={BLOUB_LOOKS[state].then}
                repeat={BLOUB_LOOKS[state].repeat}
                hold={BLOUB_LOOKS[state].hold}
                gaze={BLOUB_LOOKS[state].gaze}
                size={BLOB_SIZE_PX}
                lookXRef={lookXRef}
                follow
                baseShape={look.shape}
                color={look.color}
              />
            ) : useFallback || !src ? (
              (config.fallbackIcon ?? <DefaultFallbackIcon />)
            ) : (
              <img
                src={src}
                alt=""
                // 雙保險:圖片預設是可以被瀏覽器拖走的,那會誤觸某些頁面的
                // 「拖曳上傳」遮罩
                draggable={false}
                className="size-full object-contain"
                // 檔名打錯、還沒放進 public、格式壞掉 —— 一律退回替代圖示,
                // 不要留一個破圖 icon 或空白圓圈
                onError={() => setBrokenSrc((prev) => new Set(prev).add(src))}
              />
            )}

            {/* 滑鼠感應區,對齊角色**實際**佔的位置。
                144px 的框裡角色只佔下面約 2/3(上方是留給道具的空白),整顆按鈕
                都算的話,滑鼠明明在角色頭頂上方的空白處就會被當成「移到牠身上」。
                這幾個百分比是逐影格量出來的內容範圍:(50,103)-(243,275) / 302x300。
                換一整組圖之後要重量。

                ⚠️ 一定要放在按鈕**裡面**當子元素:放外面當兄弟節點的話,它蓋在
                角色上,滑鼠事件冒泡不到按鈕,拖曳和點擊會整個失效。 */}
            <span
              aria-hidden="true"
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => {
                setHovered(false);
                wobble.reset(); // 手一移開就扶正,不要把角度留到下一句
              }}
              // 滑鼠在牠身上左右移動時,氣泡跟著傾斜/位移
              onPointerMove={wobble.track}
              className={cn(
                "absolute",
                useFallback
                  ? "inset-0"
                  : blob
                    ? // bloub 的球置中、直徑約框的 49%(112×0.63 / 144)
                      "inset-[25%]"
                    : "bottom-[8%] left-[17%] right-[20%] top-[34%]",
              )}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 沒給 fallbackIcon 時用的內建替代圖示 */
function DefaultFallbackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="6" fill="currentColor" opacity="0.9" />
      <path d="M7 15.5V20L12.5 15.5H7Z" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────────
// 狀態推導
// ───────────────────────────────────────────────────────────────────────

/**
 * 從訊號來源推出小夥伴該是什麼表情。
 *
 * 這裡不新增任何後端欄位 —— 用的訊號(排隊、進行中、成功、失敗)本來就都在。
 */
function usePetState(viewKey?: string): PetState {
  const [, force] = useState(0);
  // 剛結束的那幾秒要顯示 happy / sad,之後回去睡
  const [transient, setTransient] = useState<PetState | null>(null);
  const lastSettledRef = useRef<string | number | null>(null);
  // 倒數計時器一定要放在 ref,不能放在下面那個 effect 的 cleanup 裡。
  //
  // 放 cleanup 會這樣壞:effect 的相依是 task 的那幾個欄位,而「完成之後 4 秒內
  // 切到別的頁」會讓 task 整個變成 undefined —— 相依變了 → cleanup 把計時器清掉
  // → effect 重跑一次卻在第一行就 return(沒有 task)→ **再也沒有人把 transient 收回去**。
  // 症狀是小夥伴永遠停在「完成了!」,只有重新整理才會好。
  const transientTimerRef = useRef<number | null>(null);

  // 任何一件工作有動靜都要重畫 —— 使用者可能正在看別的地方
  useEffect(() => getPetSource().subscribe(() => force((n) => n + 1)), []);

  const source = getPetSource();
  const task = source.getCurrentTask();
  const activeCount = source.getActiveCount();
  // viewKey 只是用來確保換頁時這個元件會重算(讓 lint 知道它有被用到)
  void viewKey;

  // 從「進行中」翻成「已結束」的那一刻,記一次表情
  useEffect(() => {
    if (!task?.done) return;
    if (lastSettledRef.current === task.id) return; // 同一件不要重複觸發
    lastSettledRef.current = task.id;
    // 使用者自己按停止不算失敗,給他看 ERROR 是在怪他,而那是他自己的決定。
    const isStopped =
      getPetConfig().isStoppedByUser ??
      ((error: string | null | undefined) => !!error?.startsWith("已停止"));
    setTransient(task.success ? "happy" : isStopped(task.error) ? "stopped" : "sad");
    // 前一件的倒數還沒跑完就換下一件(連著做兩件)時要重新計時
    if (transientTimerRef.current) window.clearTimeout(transientTimerRef.current);
    transientTimerRef.current = window.setTimeout(() => {
      transientTimerRef.current = null;
      setTransient(null);
    }, TRANSIENT_MS);
  }, [task?.done, task?.success, task?.error, task?.id]);

  // 收計時器只在元件真的被拆掉時做
  useEffect(
    () => () => {
      if (transientTimerRef.current) window.clearTimeout(transientTimerRef.current);
    },
    [],
  );

  const userIdle = useUserIdle();

  // 「跑很久」要靠時間推進才會觸發,所以進行中每 10 秒重算一次
  const [now, setNow] = useState(() => Date.now());
  const running = !!task && !task.done;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [running]);

  const raw = deriveState(task, transient, now, userIdle, activeCount);
  // 工具切換很快,直接跟著換圖會瘋狂閃 —— 撐過 MIN_STATE_MS 才真的換
  return useSettledState(raw);
}

function toolToState(tool: PetTool): PetState {
  switch (tool) {
    case "read":
      return "reading";
    case "search":
      return "searching";
    case "run":
      return "running";
    default:
      // 認不得的一律當「在做事」,不要漏掉狀態
      return "thinking";
  }
}

function deriveState(
  task: PetTask | undefined,
  transient: PetState | null,
  now: number,
  userIdle: boolean,
  activeCount: number,
): PetState {
  const capacity = getPetConfig().capacity;

  if (task && !task.done) {
    if (task.queued) return "queued";
    if (task.uploading) return "uploading";

    // 同時跑幾件。到達上限就是滿載。
    //
    // 這個蓋過工具狀態是刻意的:同時兩件以上時,「現在這張圖代表哪一件的工具」
    // 本來就講不清楚,不如直接告訴人「你手上有幾件在跑」——
    // 那才是他這時候真正需要知道的事(再來就要排隊了)。
    if (activeCount >= capacity) return "busy3";
    if (activeCount === 2) return "busy2";

    // 伺服器的提醒優先蓋過動作 —— 附件沒上傳成功這種事,使用者現在就該知道,
    // 不然他會拿到一個「沒看過那個檔案」的結果還不明白為什麼
    if (task.notices?.length) return "notice";

    // 跑超過 5 分鐘:換一個「還在慢慢掃」的樣子,告訴人「它沒卡住,只是很久」
    if (now - task.startedAt > GRINDING_AFTER_MS) return "grinding";

    // 已經在吐字了就是在寫;否則看它最後碰的是什麼工具
    if (task.streaming) return "writing";
    return task.latestTool ? toolToState(task.latestTool) : "thinking";
  }

  if (transient) return transient;
  // 自己這頁沒事,但別的地方還在跑 —— 從邊緣探頭提醒一下
  if (activeCount > 0) return "background";
  // 人還在動就散步,離開超過一分鐘就睡
  return userIdle ? "sleeping" : "walking";
}

/**
 * 使用者多久沒動了。
 *
 * 用來決定小夥伴要散步還是睡覺 —— 一直走來走去在工作畫面上是干擾,
 * 完全不動又太死。人在用就讓牠走,人離開就讓牠睡。
 *
 * 只聽 mousemove / keydown,而且用 ref 記時間、每 10 秒才重畫一次:
 * 每次滑鼠移動都 setState 的話,整個 App 會跟著使用者的滑鼠瘋狂重繪。
 */
function useUserIdle(): boolean {
  const lastActiveRef = useRef(Date.now());
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const wake = () => {
      lastActiveRef.current = Date.now();
    };
    window.addEventListener("mousemove", wake, { passive: true });
    window.addEventListener("keydown", wake);
    const timer = setInterval(() => {
      setIdle(Date.now() - lastActiveRef.current > SLEEP_AFTER_IDLE_MS);
    }, 10_000);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      clearInterval(timer);
    };
  }, []);

  return idle;
}

/**
 * 擋掉太短命的狀態。
 *
 * 讀一下、搜一下、跑個指令都在一兩秒內完成,不擋的話小夥伴會在三張圖之間
 * 瘋狂閃 —— 那比完全不動還吵,而且 GIF 每次換 src 都會從第一格重播,
 * 看起來像卡住。
 *
 * 例外:happy / sad / sleeping / walking 這種「結果」狀態要立刻反映,不用等。
 */
function useSettledState(raw: PetState): PetState {
  const [settled, setSettled] = useState(raw);
  const lastChangeRef = useRef(0);

  useEffect(() => {
    if (raw === settled) return;

    const immediate =
      raw === "happy" || raw === "sad" || raw === "sleeping" || raw === "walking";
    const waited = Date.now() - lastChangeRef.current;
    if (immediate || waited >= MIN_STATE_MS) {
      lastChangeRef.current = Date.now();
      setSettled(raw);
      return;
    }

    const timer = setTimeout(() => {
      lastChangeRef.current = Date.now();
      setSettled(raw);
    }, MIN_STATE_MS - waited);
    return () => clearTimeout(timer);
  }, [raw, settled]);

  return settled;
}

/**
 * 疊在 GIF 之上的浮動效果。GIF 自己已經會動了,這層只負責整體的呼吸/晃動,
 * 所以幅度都很小 —— 兩層動畫加起來過頭的話會很吵。
 */
const STATE_ANIMATION: Record<PetState, string> = {
  // walking 的位移套在最外層容器,這裡不要再套一次,
  // 不然會變成「容器在走、角色又自己在容器裡走」
  walking: "",
  sleeping: "pet-sleep",
  queued: "pet-wait",
  uploading: "pet-work",
  thinking: "pet-wait",
  reading: "pet-sleep",
  searching: "pet-work",
  running: "pet-work",
  writing: "pet-work",
  grinding: "pet-sleep",
  notice: "pet-wait",
  busy2: "pet-work",
  busy3: "pet-work",
  background: "pet-wait",
  happy: "pet-cheer",
  stopped: "pet-sad",
  sad: "pet-sad",
  poked: "pet-cheer",
  annoyed: "pet-wait",
};

/** 拿掉時要從當下的角度回正的狀態動畫(垂頭、左右搖 —— 停在一邊時跳回 0 最明顯) */
const SETTLE_FROM = new Set(["pet-sad", "pet-wait"]);

/**
 * 狀態動畫的 class,外加「拿掉時平順回正」。
 *
 * pet-sad 垂著頭(rotate −8~−10°)、pet-wait 搖到一邊時換狀態,class 一拿掉 transform 瞬間跳回 0,
 * 看起來是「啪」一下站直。⚠️ **CSS transition 救不了**:CSS 動畫的值不算在 transition 比的
 * 前後值裡(兩邊的底值都是 none),掛了 `transition: transform` 也不會動。
 *
 * 所以:class 要換掉之前,先把**畫面上當下的** transform 讀起來(`getComputedStyle` 含動畫的值),
 * 換掉之後用 Web Animations 從那個角度補到 none。
 * 「先讀再換」靠多撐一輪:要的 class 變了時,第一個 layout effect 在舊 class 還掛著時讀值、再 setState
 * 換掉 —— layout effect 裡的 setState 會在畫面畫出來之前同步重繪,所以舊 class 不會多停一格。
 *
 * 減少動態:狀態動畫本來就是 none(pet.css),沒有角度可以回,也就不補。
 * ⚠️ 換進去的狀態自己也有動畫(例如 pet-wait → pet-work)時,回正這段會蓋過它一下,
 * 結束時接回那支動畫的當下位置 —— 幅度都只有幾度,比整段跳回 0 好得多。
 */
function useSettleBack(
  wanted: string | undefined,
  ref: React.RefObject<HTMLElement | null>,
  reduced: boolean,
): string | undefined {
  const [shown, setShown] = useState(wanted);
  const capturedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (wanted === shown) return;
    const el = ref.current;
    capturedRef.current =
      el && !reduced && shown && SETTLE_FROM.has(shown) ? getComputedStyle(el).transform : null;
    setShown(wanted);
  }, [wanted, shown, reduced, ref]);

  useLayoutEffect(() => {
    const from = capturedRef.current;
    capturedRef.current = null;
    const el = ref.current;
    if (!el || !from || from === "none" || typeof el.animate !== "function") return;
    el.animate([{ transform: from }, { transform: "none" }], {
      duration: durationTokenMs(PET_EXIT_DURATION_TOKEN, PET_EXIT_FALLBACK_MS),
      easing: easeTokenCss(PET_EXIT_EASE_TOKEN, PET_EXIT_FALLBACK_EASE),
    });
  }, [shown, ref]);

  return shown;
}

// ───────────────────────────────────────────────────────────────────────
// 互動:戳、拖、說話
// ───────────────────────────────────────────────────────────────────────

/**
 * 戳一下的反應。
 *
 * 留著這個的理由:它只有在使用者**自己去點**的時候才出現,不會在他工作時
 * 自己跳出來 —— 跟會自己亂動的裝飾不是同一回事。
 */
function usePoke(): { reaction: PetState | null; poke: () => void } {
  const [reaction, setReaction] = useState<PetState | null>(null);
  const clicksRef = useRef<number[]>([]);

  const poke = () => {
    const now = Date.now();
    // 只留視窗內的點擊次數,判斷是「戳一下」還是「一直戳」
    clicksRef.current = [...clicksRef.current, now].filter(
      (t) => now - t < ANNOYED_WINDOW_MS,
    );
    setReaction(clicksRef.current.length >= ANNOYED_CLICKS ? "annoyed" : "poked");
  };

  // 反應是短暫的,時間到就回去看真實狀態
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), POKE_MS);
    return () => clearTimeout(timer);
  }, [reaction]);

  return { reaction, poke };
}

/**
 * 用滑鼠把小夥伴拖到別的地方。
 *
 * 拖過之後就以那裡為家,散步的起點跟著換過去 —— 使用者手動擺的位置代表
 * 「我要牠待在這一區」,不是「我要牠從此站著不動」。
 * 位置記在 localStorage,重新整理還在原處。
 *
 * 拖曳與點擊要分得開:移動超過 DRAG_THRESHOLD_PX 才算拖,不然使用者
 * 只是想戳一下卻手抖了幾像素,就變成把牠拖走而不是看到反應。
 */
const DRAG_THRESHOLD_PX = 4;

interface PetPosition {
  x: number;
  y: number;
}

/** 小夥伴的顯示尺寸(size-36 = 144px)。夾邊界時要留出這塊,不然只剩半隻在畫面上 */
const PET_SIZE_PX = 144;

/** 散步一趟最多走多遠;以及「還值得走」的下限 —— 再短就只是在原地抖 */
const WALK_MAX_PX = 200;
const WALK_MIN_PX = 60;

/**
 * 讀出釘住的位置,並夾回目前視窗範圍內。
 *
 * 夾這一下是必要的:位置是絕對座標,在寬螢幕拖到右邊之後,換到筆電或把視窗
 * 縮小再打開,那個座標就落在畫面外 —— 小夥伴等於消失了,而且沒有任何入口叫得回來。
 */
function readPinned(): PetPosition | null {
  try {
    const raw = localStorage.getItem(petPositionKey());
    if (!raw) return null;
    const saved = JSON.parse(raw) as PetPosition;
    return {
      x: Math.min(Math.max(0, saved.x), Math.max(0, window.innerWidth - PET_SIZE_PX)),
      y: Math.min(Math.max(0, saved.y), Math.max(0, window.innerHeight - PET_SIZE_PX)),
    };
  } catch {
    return null;
  }
}

function usePetDrag(moveRef: React.RefObject<HTMLElement | null>) {
  const [pinned, setPinned] = useState<PetPosition | null>(() => readPinned());
  const [dragging, setDragging] = useState(false);
  /**
   * 這一次指標互動的起點。`x / y` 是按下去那一刻畫面上看到的位置(含散步的位移);
   * `w / h` 是按鈕的大小(夾邊界用,拖曳中不會變,不必每個 move 都量一次 —— 那會在寫完 transform
   * 之後馬上讀版面,每一格強迫重排)。
   */
  const originRef = useRef<{ px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);
  const movedRef = useRef(false);
  // 放開滑鼠時要存的位置一定要從 ref 讀,不能讀 state。
  // pointerup 的處理函式抓到的是「它被建立時那一輪」的 pinned —— 拖曳過程中
  // 如果沒有發生重繪(快速拖放就會這樣),那個值還是舊的,結果就是位置沒存到,
  // 重新整理之後牠又跳回右下角。
  // (拖曳中本來就不重繪,見 onPointerMove —— 這條更是非讀 ref 不可。)
  const latestRef = useRef<PetPosition | null>(null);
  /**
   * 這一次拖曳歸哪一根指標管(多點觸控保護;規則見 `lib/pointerOwner.ts`)。
   * 每一下 pointerdown 都覆寫起點的話,第二根手指(或觸控筆電上另一隻手)一按,
   * 小夥伴就跳到另一根手指底下;任一根抬起也會把拖曳收掉。
   */
  const owner = useState(createPointerOwner)[0];

  // 視窗縮放時重新夾一次邊界,不然把視窗縮小之後小夥伴會被留在畫面外。
  // 外部呼叫 `unpinPet()`(「回到原位」)也是走同一條路 —— 位置清掉之後這裡要跟著
  // 讀回 null,牠才會馬上回右下角繼續散步(不然要重新整理才看得到)。
  //
  // ⚠️ **這個 app 沒有任何「回到原位」的 UI 入口**(放在側邊欄容易被讀成隱藏/顯示的開關)。
  // `PET_POSITION_EVENT` 這條線**不要因此拆掉**:
  // `unpinPet` 是元件包對外的 API(`pet-companion-kit/README.md` 與 examples/3 都在用),
  // 拆了就是把別人的入口弄壞。少了 UI 入口不影響這個 app —— 釘住的座標一律夾在視窗內
  // (見 `readPinned` 與拖曳那兩行 `Math.min/max`),所以牠永遠拖得動,再拖一次就好。
  //
  // ⚠️ 拖到一半不重讀:拖曳中的位置是「釘點 + transform」,這時把釘點換成存檔裡的舊座標,
  // 牠會跳開一段。放手時本來就會用當下的視窗大小夾好再存。
  useEffect(() => {
    const sync = () => {
      if (originRef.current && movedRef.current) return;
      setPinned(readPinned());
    };
    window.addEventListener("resize", sync);
    window.addEventListener(PET_POSITION_EVENT, sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener(PET_POSITION_EVENT, sync);
    };
  }, []);

  /**
   * 收掉這一次互動。真的拖過的話:把最後的位置交給 React(`setPinned`)、存起來、拿掉拖曳中的 transform。
   * ⚠️ 不碰 `owner`:呼叫端各自決定要不要放掉那根指標(換手重來時新的那根已經接手了)。
   */
  const finish = () => {
    originRef.current = null;
    const pos = latestRef.current;
    if (!movedRef.current || !pos) return;
    // flushSync:新的 left / top 跟拿掉 transform 要在**同一格**畫出來,不然會有一格停在舊的釘點
    if (moveRef.current) moveRef.current.style.transform = "";
    flushSync(() => {
      setPinned(pos);
      setDragging(false);
    });
    localStorage.setItem(petPositionKey(), JSON.stringify(pos));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // 只接左鍵/主要指標,右鍵選單之類的不要攔
    if (e.button !== 0) return;
    // 擋掉瀏覽器的原生拖曳。
    //
    // 沒有這行的話,按住角色往旁邊拖會啟動「把圖片拖出去」的原生行為,而 Chrome
    // 在拖圖片時會把 "Files" 放進 dataTransfer.types(它支援拖出去存成檔案)——
    // 剛好通過某些頁面 types.includes("Files") 的檢查,上傳遮罩就跳出來蓋住畫面。
    e.preventDefault();
    // 已經有別的指標在拖(第二根手指、別種指標):不理。
    // 上一次的收尾事件漏了(restarted):照放手處理掉舊的那次,再由這一根重來
    const claim = owner.claim(e);
    if (claim === "ignored") return;
    if (claim === "restarted") finish();
    // 這個 rect 是**畫面上看到的位置**(含散步動畫當下的位移)—— 這正是要的:
    // 拖曳從眼睛看到的地方接手,下面第一次移動時就把牠釘在這個位置。
    const rect = e.currentTarget.getBoundingClientRect();
    originRef.current = {
      px: e.clientX,
      py: e.clientY,
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
    };
    movedRef.current = false;
    latestRef.current = null;
    // 指標捕捉:滑鼠移到視窗其他元素上面時事件還是送到這裡來,
    // 沒有這行的話拖快一點就會「掉」在半路
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** 夾在視窗內,不然可以把牠拖到看不見的地方就再也抓不回來 */
  const clampTo = (origin: NonNullable<typeof originRef.current>, x: number, y: number): PetPosition => ({
    x: Math.min(Math.max(0, x), window.innerWidth - origin.w),
    y: Math.min(Math.max(0, y), window.innerHeight - origin.h),
  });

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (!origin || !owner.owns(e)) return;
    const dx = e.clientX - origin.px;
    const dy = e.clientY - origin.py;
    if (!movedRef.current) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // dragging 要等**真的拖了**才開,不能在 pointerdown 就開:
      // 它會讓散步的位移歸零(usePetWander 的 resetKey),而這裡 setPinned 給的正是
      // 「位移歸零後該在的位置」(按下去那一刻看到的位置)—— 兩個 state 在同一輪 commit,
      // 歸零在 useLayoutEffect 裡做(畫面畫出來之前),所以不會跳。
      // 在 pointerdown 就開的話,只是想戳一下也會讓牠先閃回原點。
      //
      // ⚠️ 這是整趟拖曳**唯一一次**重繪:之後每個 move 只寫外層的 transform,
      // 放手才把最後的位置交給 React。每個 move 都 setPinned 的話,整個小夥伴(framer 的氣泡、
      // BloubAvatar)會跟著手指一秒重繪幾十次,而且動的是 left / top(每格重排)。
      // flushSync:釘點與散步位移歸零要在寫第一筆 transform **之前**落定 ——
      // pointermove 是連續事件,React 不會同步 commit,晚一拍的話歸零會把下面那筆 transform 一起清掉。
      movedRef.current = true;
      const base = clampTo(origin, origin.x, origin.y);
      // 拖曳從這個釘點出發;起點也夾過,transform 的位移就以它為準
      origin.x = base.x;
      origin.y = base.y;
      flushSync(() => {
        setDragging(true);
        setPinned(base);
      });
    }
    const pos = clampTo(origin, origin.x + dx, origin.y + dy);
    latestRef.current = pos;
    // 只動 transform(合成層),跟拖曳幽靈同一個做法
    if (moveRef.current) {
      moveRef.current.style.transform = `translate(${pos.x - origin.x}px, ${pos.y - origin.y}px)`;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!owner.owns(e)) return;
    owner.release(e);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    finish();
  };

  /**
   * 取消 / 失去捕捉:只有管事的那一根算數。照放手處理(停在當下的位置)—— 畫面上牠已經在那裡了,
   * 彈回原處反而像出錯。抓住的指標不管怎麼結束都會發 lostpointercapture,up / cancel 被攔掉也收得到。
   */
  const onPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (owner.release(e)) finish();
  };

  return {
    pinned,
    dragging,
    /** 這次指標互動有沒有真的拖動過 —— 拖過就不要再觸發「戳」的反應 */
    didDrag: () => movedRef.current,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
    },
  };
}

/**
 * 小夥伴要說的話。跟「狀態」分開:狀態是牠在做什麼(在讀資料、在搜尋),
 * 這是牠要告訴你的事(有人分享東西給你)—— 跟你當下這一頁無關,所以
 * 不能只靠改表情,要有文字。
 */
function useSpeech() {
  const [speech, setSpeech] = useState<PetSpeech | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const onSpeak = (e: Event) => {
      const detail = (e as CustomEvent<PetSpeech>).detail;
      if (!detail.text) return;
      setSpeech(detail);
      // 連續來兩則時,後面那則要重新計時 —— 不重設的話第二則只會顯示到
      // 第一則的倒數結束為止,可能一閃就沒了
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setSpeech(null), SPEECH_MS);
    };
    window.addEventListener(PET_SPEAK_EVENT, onSpeak);
    return () => {
      window.removeEventListener(PET_SPEAK_EVENT, onSpeak);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return { speech, dismiss: () => setSpeech(null) };
}

/**
 * 狀態一換就自己把那句台詞冒出來,停 AUTO_SPEECH_MS 之後收回去。
 *
 * 收回去而不是一直掛著,是因為閒著時那句(「閒晃中,有問題就問」)沒有時效 ——
 * 一直浮在畫面上就從狀態指示變成裝飾。有事發生時本來就會一直換狀態,
 * 氣泡自然會一直接著出現。
 *
 * 進來的 state 已經過 useSettledState 擋過抖動,所以這裡不必再防連續觸發。
 */
function useAutoSpeech(state: PetState): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), AUTO_SPEECH_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return visible;
}
