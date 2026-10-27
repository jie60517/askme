/**
 * 例三:掛進 App、以及「顯示/隱藏」與「回到原位」的入口
 *
 * ⚠️ **開關入口一定要做。** 這不是加分項:
 *   - 關閉小夥伴的動作如果只長在小夥伴身上,關掉之後那顆鈕跟著消失,
 *     使用者就沒有任何入口把牠叫回來了。
 *   - 位置存在 localStorage,拖到角落之後重新整理還在那裡 ——
 *     沒有「回到原位」的話同樣叫不回來。
 *
 * 本專案是放在指令面板(Ctrl+K)裡,你放在設定頁、右鍵選單、使用者選單都行,
 * 重點是**在小夥伴以外的地方**。
 *
 * ⚠️ **`examples/` 不在任何建置或型別檢查流程裡**(`frontend/tsconfig.json` 的
 * `include` 只有 `["src", "vite.config.ts"]`)。改 `frontend/src/pet/` 的對外 API
 * 時請回來把這三份看一遍 —— 它們跟正本分岔了不會有任何自動機制抓到。
 */

import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { Eye, EyeOff, Move } from "lucide-react";

import PetCompanion, {
  configurePet,
  isPetHidden,
  isPetPinned,
  setPetHidden,
  unpinPet,
  PET_VISIBILITY_EVENT,
  PET_POSITION_EVENT,
  // 正本在 frontend/src/pet/(見 README 開頭的說明),不在這個資料夾裡
} from "../../frontend/src/pet";

// ── 1. 設定(放在模組層級,元件掛上去之前就要跑過)────────────────────
configurePet({
  name: "小夥伴",
  capacity: 3,
  storagePrefix: "myapp_pet",
  // 有 router 的話一定要給:預設的 <a href> 會整頁重新載入
  renderLink: (href, children, onClick) => (
    <Link to={href} onClick={onClick} className="underline-offset-2 hover:underline">
      {children}
    </Link>
  ),
});

// ── 2. 掛在最外層 ─────────────────────────────────────────────────────
export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div className="relative flex h-dvh">
      {children}

      {/* 跨頁常駐 —— 工作跑十幾分鐘時使用者常常切去看別的東西。
          viewKey 讓牠在換頁時立刻重算「我這頁到底有沒有事在跑」。

          ⚠️ 手機要**整個不渲染**(SPEC 3、驗收清單最後一項)。元件自己的
          className 帶了 `hidden md:block`,但那只在有 Tailwind(或有等效墊片)
          的專案生效,而且它只是把畫面藏起來 —— GIF、計時器與 lazy chunk 照樣
          下載與執行。兩種都要擋的話在掛載這裡加一個條件,本專案就是這樣做的:
          `{!isMobile && <PetCompanion … />}`,見 `frontend/src/App.tsx`。 */}
      <PetCompanion viewKey={location.pathname} />
    </div>
  );
}

// ── 3. 開關入口(這裡示範指令面板的兩個項目)──────────────────────────
export function usePetCommands() {
  const [hidden, setHidden] = useState(isPetHidden);
  const [pinned, setPinned] = useState(isPetPinned);

  // 兩個入口(小夥伴自己、這裡)都改同一份 localStorage,靠事件同步 ——
  // 各記一份 state 的話會對不起來
  useEffect(() => {
    const sync = () => {
      setHidden(isPetHidden());
      setPinned(isPetPinned());
    };
    window.addEventListener(PET_VISIBILITY_EVENT, sync);
    window.addEventListener(PET_POSITION_EVENT, sync);
    return () => {
      window.removeEventListener(PET_VISIBILITY_EVENT, sync);
      window.removeEventListener(PET_POSITION_EVENT, sync);
    };
  }, []);

  const items = [
    {
      id: "pet",
      label: hidden ? "顯示小夥伴" : "隱藏小夥伴",
      icon: hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
      onSelect: () => setPetHidden(!hidden),
    },
  ];

  // 被拖走了才需要這一項 —— 沒拖過的話牠本來就在原位
  if (pinned && !hidden) {
    items.push({
      id: "pet-unpin",
      label: "小夥伴回到原位",
      icon: <Move className="size-4" />,
      onSelect: unpinPet,
    });
  }

  return items;
}

// ── 4. 讓牠說話(任何地方都能呼叫,不需要 context)──────────────────
//
//   import { petSay } from "../../frontend/src/pet";
//
//   petSay({
//     text: "阿華 @你:這個簽核你熟",
//     state: "happy",              // 順便換個表情
//     href: "/c/abc-123",          // 給了才變成可以點的
//   });
//
// 用在「跟使用者當下這一頁無關、但他會想知道」的事情上。
// 系統錯誤那類請繼續用 toast —— 混在同一個通道裡,重要的那則會被當雜訊滑過去。
