/**
 * 全域外框。
 *
 * 三段式 gate:身分載入中 → 骨架;未登入 → 只渲染 Login;
 * 已登入但 password_is_default → 只渲染 ForcePasswordChange;其餘才掛整組 chrome。
 *
 * ⚠️ 未登入時整組 chrome 都不渲染。側邊欄 / 命令面板 / 小夥伴各自會打需要登入的 API,
 * 在登入頁渲染它們 = 送出一串必定 401 的請求,而 401 攔截器會清 token,自己把狀態洗掉。
 */
import {
  Suspense,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
} from 'react';
import {
  Link as RouterLink,
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

import * as stylex from '@stylexjs/stylex';

import {AppShell} from '@astryxdesign/core/AppShell';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {Stack} from '@astryxdesign/core/Layout';
import {LayerProvider} from '@astryxdesign/core/Layer';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import {AccountSettingsDialog} from './components/AccountSettingsDialog';
import {ChangePasswordDialog} from './components/ChangePasswordDialog';
import {CommandPalette} from './components/CommandPalette';
import {ErrorBoundary} from './components/ErrorBoundary';
import {JumpSpotlight} from './components/JumpSpotlight';
import {LoadingScreen} from './components/LoadingScreen';
import {MobileBrandBar} from './components/MobileBrandBar';
import {Sidebar} from './components/Sidebar';
import {RunningNavDot} from './components/RunningNavDot';
import {UpdateWatcher} from './components/UpdateWatcher';
import Chat from './pages/Chat';
import {isRouterHref} from './lib/appLink';
import {conversationIdFromPath, morphChat, shouldMorphChat} from './lib/chatTransition';
import {bindPageSwapHost, finishPageSwap, shouldSwapPage, startPageSwap} from './lib/pageSwap';
import {prefetchConversation} from './lib/chatApi';
import {transitionMs} from './lib/transitionMs';
import {isStale, subscribeStale} from './lib/appVersion';
import {wouldLoseWork} from './lib/unsavedWork';
import {lazyChunk} from './lib/lazyChunk';
import {adoptServerPrefs} from './lib/displayPrefs';
import {adoptServerBlobColor, adoptServerBlobShape, adoptServerCompanion} from './lib/companionPref';
import {adoptServerModel} from './lib/modelPref';
import {MOBILE_QUERY, useMediaQuery} from './lib/media';
import {registerSelf} from './lib/peopleDirectory';
import {adoptServerTheme, useThemeMode} from './lib/theme';
import {BRAND_NAME} from './lib/brand';
import {MenuHighlightLayer} from './components/MenuHighlightLayer';
import {NoticeStack} from './components/NoticeStack';
// 小夥伴的接線(pet-companion-kit):模組層執行 configure,一定要在元件掛上前 import
import {setPetUnread} from './lib/petSetup';
import {startSharedWatch} from './lib/sharedWatch';
import {MeProvider, useIdentity, type Me} from './lib/useIdentity';


// 只有 Chat 是同步 import —— 它是打開網站第一眼看到的畫面,
// 走 lazy 等於每次進站都先看一次載入畫面。其餘的頁面才 lazy。
const PetCompanion = lazyChunk(() => import('./pet'));
const Stats = lazyChunk(() => import('./pages/Stats'));
const Questions = lazyChunk(() => import('./pages/Questions'));
const Security = lazyChunk(() => import('./pages/Security'));
const Users = lazyChunk(() => import('./pages/Users'));
const Login = lazyChunk(() => import('./pages/Login'));
const ForcePasswordChange = lazyChunk(() => import('./pages/ForcePasswordChange'));
const NotFound = lazyChunk(() => import('./pages/NotFound'));
// SSH 終端機:只有工程師用得到,xterm.js 跟著這一頁一起 lazy
const Terminal = lazyChunk(() => import('./pages/Terminal'));
// 個人筆記:所有人都有,但不是進站第一眼,一樣 lazy
const Notes = lazyChunk(() => import('./pages/Notes'));
// Work Flow:可選功能,跟 /ssh 同一群人用,畫布整頁 lazy
const Workflow = lazyChunk(() => import('./pages/Workflow'));

/**
 * 讓 Astryx 元件裡的連結走 SPA 導覽,而不是整頁重載(規則:不寫死 <a>)。
 *
 * ⚠️ 「這個 href 是不是前端路由」的判斷在 `lib/appLink.ts`,不要挪回來寫死在這裡 ——
 * 它有一條(`/api/...`)只有正式 build 才會走到,抽出去是為了測得到。
 *
 * **站上已經上了新版之後,這裡是把人帶過去的地方**(`lib/appVersion.ts` 三段式的第一段)。
 * 全站每一個連結都經過這支(`LinkProvider`),所以只要在這裡少走一次前端跳轉,
 * 使用者下一次點側邊欄就是一趟真正的導覽 —— 對他來說只是換了一頁,
 * 換完卻已經在新版上了。**絕大多數人只會遇到這一段,而且不會發現。**
 */
const AppLink = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<'a'>>(
  function AppLink({href, ...rest}, ref) {
    // 訂閱而不是直接讀:變成舊版那一刻,已經畫出來的那幾十個連結要跟著換掉,
    // 不然這一段只對「之後才重新渲染的連結」生效,而側邊欄平常不會重畫。
    const stale = useSyncExternalStore(subscribeStale, isStale, isStale);
    const {pathname} = useLocation();
    const navigate = useNavigate();
    if (!isRouterHref(href)) {
      return <a ref={ref} href={href} {...rest} />;
    }
    /*
     * 換頁的兩種過場:
     *   - New chat ↔ 對話(兩組對話互切也是,`lib/chatTransition.ts`):輸入框滑過去;
     *   - 換功能頁(`lib/pageSwap.ts`):側邊欄的選取底色滑過去、內容區快速淡換。
     *     這段**不攔下換頁**:點下去當下舊頁開始淡、選取底色開始滑,換頁照常交給 RouterLink。
     * 只接**一般的左鍵點擊**:中鍵、Ctrl / ⌘ 點、Shift 點要開新分頁 / 新視窗,照舊交給瀏覽器。
     * 呼叫端自己的 onClick 先跑,它擋下了(preventDefault)就不動。
     */
    const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      rest.onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // 另開分頁 / 下載的連結 RouterLink 不在這一頁換頁 —— 起了過場的話,這一頁會淡成空白等兩秒才回來
      if ((rest.target && rest.target !== '_self') || rest.download != null) return;
      /*
       * 已經是舊版:這一下改成整頁換過去(三段式的第一段)—— **除非會弄丟東西**(`lib/unsavedWork`)。
       * SSH 連線可能藏在背景(換頁不斷線),整頁換 = 把它砍掉,還會先跳瀏覽器的「離開網站?」。
       * 所以在點下去那一刻才判斷,不是一變成舊版就把所有連結換成 <a>。
       */
      if (stale && !wouldLoseWork()) {
        e.preventDefault();
        window.location.assign(href as string);
        return;
      }
      if (shouldMorphChat(pathname, href)) {
        e.preventDefault();
        void morphChat(() => navigate(href as string));
      } else if (shouldSwapPage(pathname, href)) {
        startPageSwap(href as string);
      }
    };
    /*
     * 指到某組對話的連結:滑鼠移上去(觸控是手指按下去)就先抓它的歷史與檔案清單。
     * 點下去時對話頁掛上的第一格就是完整的樣子,過場拍到的終點畫面不會是空殼
     *(見 `lib/chatApi.ts` 的那段快取說明)。從移上去到點下去通常有一兩百毫秒,夠一趟來回。
     */
    const conversationId = conversationIdFromPath(href);
    const prefetch = (own?: React.PointerEventHandler<HTMLAnchorElement>) => (e: React.PointerEvent<HTMLAnchorElement>) => {
      own?.(e);
      if (conversationId) prefetchConversation(conversationId);
    };
    return (
      <RouterLink
        ref={ref}
        to={href}
        {...rest}
        onClick={onClick}
        onPointerEnter={prefetch(rest.onPointerEnter)}
        onPointerDown={prefetch(rest.onPointerDown)}
      />
    );
  },
);

/*
 * 「跳到主要內容」由 **AppShell 內建的那一個**負責
 * (`AppShell.tsx` 自己畫 skip link + `#astryx-app-shell-main`,是全頁第一個 Tab 停點)。
 * ⚠️ 不要在這裡另做 skip link 或 <main>:鍵盤會碰到兩個,而且自做的那個排在側邊欄之後。
 */
const mainStyles = stylex.create({
  /**
   * 路由內容的包裝。
   *
   * ⚠️ **一定要撐滿高度。** 它預設只有內容那麼高,於是問答頁的 `ChatLayout`(`flex: 1 1 0`)
   * 也跟著只有內容那麼高,**輸入框就停在半空中而不是釘在底部**。父層 `#astryx-app-shell-main` 是 block 不是 flex,
   * 所以要用 height 100% 而不是 flex:1。
   */
  main: {height: '100%'},
  /** 背景掛著的 SSH 頁(見 `keepSsh`):在 /ssh 時撐滿,其他頁整個不佔位 */
  ssh: {height: '100%'},
  sshAway: {display: 'none'},
});

/**
 * 換功能頁的過場(`lib/pageSwap.ts`):新頁跟著換頁那一次 commit 掛上了 → 淡入。
 *
 * 這個元件在 `Suspense` **外面**、跟路由同一棵樹:換頁被 react-router 包在 startTransition 裡,
 * lazy 的頁面還沒載好時整個換頁不會 commit —— 所以這裡看到新網址的那一刻,新頁一定已經畫上去了。
 * 不是過場換過來的(網址列直接打、上一頁)`finishPageSwap` 什麼都不做。
 */
function PageSwapDone() {
  const {pathname} = useLocation();
  useLayoutEffect(() => finishPageSwap(), [pathname]);
  return null;
}

/**
 * 分頁標題。**只有站名,不加頁名**。留著這個元件而不是把標題寫死在 index.html,
 * 是因為換路由時要把它蓋回來 —— 有人手動改過 document.title 的話至少會回到站名。
 */
function PageTitle() {
  const {pathname} = useLocation();
  useEffect(() => {
    document.title = BRAND_NAME;
  }, [pathname]);
  return null;
}

/**
 * 載入中。**整頁那兩處要傳 `isFullPage`** —— 那時候外面沒有撐開高度的版面,
 * 不傳的話它會塌成內容高度,圖示就貼在畫面最上面。
 * 路由切換那一次(AppShell 主內容區底下)外面已經有版面撐著,不用傳。
 */
function Loading({isFullPage, hasScene = true}: {isFullPage?: boolean; hasScene?: boolean}) {
  // 整頁、路由切換、登入登出的蓋子,**一律是風的場景**,不是 Spinner
  // (見 `components/LoadingScreen.tsx` 的 `hasScene`)。
  // 唯一關掉的是「被蓋子壓住、根本看不到」的那一格(外層 Suspense 在開機前)。
  return <LoadingScreen isFullPage={isFullPage} hasScene={hasScene} />;
}

const handoffStyles = stylex.create({
  /**
   * 蓋在首屏上面的那一層。fixed + inset 0,因為底下那棵樹是正常排版的,
   * 不能讓它撐開捲軸。z-index 90 —— 見 `global.css` 那張層級表(最上層)。
   * ⚠️ 這裡**不畫底色**:底色是 `LoadingScreen` 的 `fullPage` 自己畫的,
   * 在這裡再畫一次的話,下次改 token 會有兩個地方要改。
   */
  layer: {position: 'fixed', inset: 0, zIndex: 90},
});

/**
 * 首屏真的掛上去了。放在 `Suspense` 的 children 裡面 —— 分包還沒到的時候整個
 * boundary 是 fallback,這一顆根本不會 commit,所以它的 effect 就是
 * 「分包載完、而且 React 已經把內容 commit 進 DOM」那一刻。
 *
 * ⚠️ 用 `useEffect` 不是 `useLayoutEffect`:layout effect **一定**在瀏覽器畫下去
 * 之前跑,那樣等於在首屏還沒出現時就開始淡。passive effect 沒有這個問題。
 */
function BootReady({onReady}: {onReady: () => void}) {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

/**
 * 載入 → 首屏的交棒:載入畫面淡出、首屏從底下露出來,而不是一幀換掉。
 *
 * 閃的成因與為什麼非得多一層,寫在 `global.css` 的 `[data-handoff-layer]` 上面。
 * 這邊只管三個狀態:
 *
 *   hold    —— 蓋著,底下在載 / 在畫
 *   leaving —— 底下畫好了,加上 `data-leaving` 讓 CSS 淡掉
 *   gone    —— 淡完了,整層卸掉(連同那顆 WebGLRenderer)
 *
 * ⚠️ `hold` 那一格**不能跳過**。`[data-leaving]` 是靠 transition 跑的,
 * 瀏覽器要先有一個「之前的值」才能內插 —— 元素必須先以 `opacity: 1` 被畫出來過。
 * 開機時一定會經過(`useIdentity` 的 `loading` 初值就是 `true`),
 * 但**不要**為了省一次 render 把初值直接設成 `leaving`。
 */
function BootHandoff({booting}: {booting: boolean}) {
  const [phase, setPhase] = useState<'hold' | 'leaving' | 'gone'>(booting ? 'hold' : 'gone');
  const layerRef = useRef<HTMLDivElement>(null);
  /*
   * ⚠️ 蓋子不是只蓋一次:`booting` 是 `loading || !isBooted`,而 `useIdentity` 在
   * `IDENTITY_CHANGED`(`lib/auth.ts` 三處 dispatch:登入、登出、換 token)會把
   * `loading` 設回 `true` —— 所以**每次登入 / 登出都會再蓋一次**,每一次都是風的場景。
   *
   * ⚠️ **要驗「有沒有場景」的話,不要數 `canvas`。** Astryx 的 `Spinner`
   * 自己就畫在一塊 20×20 的 `<canvas>` 上。判準是那一層裡有沒有 `[role="progressbar"]`
   * (有場景)還是 `[role="status"]`(只有 Spinner,WebGL 建不起來時的退路)。
   */
  useEffect(() => {
    if (booting) {
      setPhase('hold');
      return;
    }
    // 用函式式更新而不是直接 `setPhase('leaving')`:這支 effect 會在
    // `booting` 每次變動時重跑(嚴格模式下開發時還會多跑一輪),
    // 已經走到 `gone` 的就要留在 `gone`,不能讓蓋子復活。
    setPhase((p) => (p === 'hold' ? 'leaving' : p));
    const timer = window.setTimeout(() => {
      setPhase((p) => (p === 'leaving' ? 'gone' : p));
    }, transitionMs(layerRef.current));
    // ↑ 淡掉要多久去問 global.css 的 `[data-handoff-layer]` 本人(`var(--duration-medium)`),
    //   不在 JS 抄一份數字
    return () => window.clearTimeout(timer);
  }, [booting]);

  if (phase === 'gone') return null;
  return (
    <Stack
      ref={layerRef}
      xstyle={handoffStyles.layer}
      data-handoff-layer=""
      data-leaving={phase === 'leaving' ? '' : undefined}
    >
      <Loading isFullPage />
    </Stack>
  );
}

function AdminOnly({me, children}: {me: Me; children: React.ReactNode}) {
  if (!me.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** 個人筆記:功能開了才有(後端 NOTEBOOK_ENABLED,預設開;關掉的話 .env 一行)。關著時 API 也是 404 */
function NotebookOnly({me, children}: {me: Me; children: React.ReactNode}) {
  if (!me.can_notebook) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Work Flow:部署的人放了 workflow_actions.json 才有(`workflow_enabled`)。沒有的話 `/workflow` 跟不存在的網址一樣走 NotFound。
 * 開了但不是工程師的人照樣進得來:頁面自己顯示「只開放給工程師」,真正的擋在後端。
 */
function WorkflowOnly({me, children}: {me: Me; children: React.ReactNode}) {
  if (!me.workflow_enabled) return <NotFound />;
  return <>{children}</>;
}

/**
 * 換一組對話一定要**重新掛載**。
 *
 * 不重掛的話 draft 與 turns 會跨對話殘留 —— A 還在跑時打開 B,
 * A 的進行中訊息會渲染在 B 裡面(pending 是模組層的,重掛不會弄丟它;
 * 會弄丟的只有這一頁自己的暫存,那正是要弄丟的東西)。
 */
function ChatRoute() {
  const {id} = useParams();
  return <Chat key={id ?? '__new__'} />;
}

function Chrome({me, onIdentityChanged}: {me: Me; onIdentityChanged: () => void}) {
  /**
   * 從整頁的載入畫面接手過來的淡入。
   *
   * 前一格是 100dvh 的波紋,下一格是整組 AppShell —— 中間一幀換掉,
   * 而這是每次開 App 的**第一眼**。
   * `useEntryAnimation` 只有在元素是「首次繪製之後才插進來」時才會動,
   * 所以之後的任何重繪都不會再淡一次。
   *
   * ⚠️ 用 `fadeIn` 不是 `scaleIn`:縮放是給**從觸發點長出來**的浮層用的,
   *    整頁換手沒有觸發點,縮放只會讓人覺得畫面在呼吸。
   */
  const entry = useEntryAnimation('fadeIn');
  /**
   * 找舊對話的那個面板開著沒。
   *
   * 放在這一層是因為**兩個入口都要動它**:⌘K(面板自己的熱鍵)與側邊欄的 Search。
   */
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  /*
   * 「改密碼」與「個人設定」也掛在這一層,不放在側邊欄裡:
   * 手機版側邊欄在抽屜裡,點選單項目抽屜一關、裡面跟著卸掉,對話框就不會出現。
   */
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // 手機斷點跟 AppShell 切抽屜的那條線同一條(見 lib/media.ts)
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // 小夥伴的 viewKey(換頁時要立刻重算「這頁有沒有事在跑」)
  const {pathname} = useLocation();
  /*
   * **換頁不斷線**:SSH 連著也能去別頁問問題。
   * SSH 頁第一次打開之後就**一直掛著**,換到別頁只是藏起來(`sshAway`):連線、檔案欄、AskME 都留著,
   * 回到 SSH Server 是原本的畫面。關分頁 / 關瀏覽器 / 登出(這一層卸掉)才斷。
   * 路由那一格 `/ssh` 因此不畫東西(`element={null}`),頁面畫在 Routes 外面。
   */
  const isSshPage = pathname === '/ssh';
  const [keepSsh, setKeepSsh] = useState(isSshPage);
  if (isSshPage && !keepSsh) setKeepSsh(true);
  /*
   * 通知輪詢。掛在**已登入的那一層**:未登入時打那幾支必定 401,
   * 而 401 攔截器會清 token,自己把狀態洗掉。
   * 相依只有 `me.username` —— 換帳號時整組重來(舊的基準不能留給新的人,
   * 不然他一進來就會被通報一輪其實是上一個人早就看過的東西)。
   */
  /*
   * 未讀數餵給小夥伴:
   * 閒著而且有人 @ 我還沒讀時,它會舉那張 notification 的圖。
   * 做法見 `lib/petSetup.tsx` 的 setPetUnread —— 不改 kit 本體。
   */
  useEffect(
    () => startSharedWatch(me.username, (unread) => setPetUnread(unread)),
    [me.username],
  );

  return (
    <MeProvider value={me}>
    <AppShell
      xstyle={entry}
      contentPadding={0}
      sideNav={
        <Sidebar
          me={me}
          onOpenSearch={() => setIsSearchOpen(true)}
          onOpenChangePassword={() => setIsChangingPassword(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      }
      /*
       * 手機版的頂列自己畫(鈕在左上、兩條槓、展開時轉成 X、站名置中)。`hasToggle: false` 讓 AppShell 不再長它那條
       * 「品牌列撐滿 + 右上漢堡鈕」的頂列;抽屜(從左邊滑出的 modal)照舊由它管,
       * 我們的 `MenuToggle` 透過它的 context 開關。
       * 頂列走 `banner` 插槽:它在 Layout 的 header 區,不會跟內容一起捲;
       * 只在手機斷點才給,桌機沒有這條。
       */
      mobileNav={{hasToggle: false}}
      banner={isMobile ? <MobileBrandBar /> : undefined}
    >
      <PageTitle />
      <PageSwapDone />
      {/* 換功能頁時淡出淡入的就是這一層(`lib/pageSwap.ts`) */}
      <Stack ref={bindPageSwapHost} xstyle={mainStyles.main}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<ChatRoute />} />
          <Route path="/c/:id" element={<ChatRoute />} />
          <Route
            path="/stats"
            element={
              <AdminOnly me={me}>
                <Stats />
              </AdminOnly>
            }
          />
          {/* 明細在總覽底下一層:總覽回答「多不多」,這一頁回答「為什麼這麼貴」。
              網址掛在 /stats 底下,側邊欄的 Usage 才會跟著亮(它比的是 startsWith)。 */}
          <Route
            path="/stats/questions"
            element={
              <AdminOnly me={me}>
                <Questions />
              </AdminOnly>
            }
          />
          <Route
            path="/security"
            element={
              <AdminOnly me={me}>
                <Security />
              </AdminOnly>
            }
          />
          <Route
            path="/users"
            element={
              <AdminOnly me={me}>
                <Users />
              </AdminOnly>
            }
          />
          {/* SSH 終端機。沒權限的人不導走 —— 頁面自己顯示「只開放給工程師」,
              直接打網址的人才知道為什麼看不到;真正的擋在後端的 WebSocket。 */}
          <Route path="/ssh" element={null} />
          <Route
            path="/workflow"
            element={
              <WorkflowOnly me={me}>
                <Workflow />
              </WorkflowOnly>
            }
          />
          <Route
            path="/workflow/:id"
            element={
              <WorkflowOnly me={me}>
                <Workflow />
              </WorkflowOnly>
            }
          />
          <Route
            path="/notes"
            element={
              <NotebookOnly me={me}>
                <Notes />
              </NotebookOnly>
            }
          />
          <Route
            path="/notes/:id"
            element={
              <NotebookOnly me={me}>
                <Notes />
              </NotebookOnly>
            }
          />
          {/* 舊網址相容 */}
          <Route path="/locks" element={<Navigate to="/security" replace />} />
          <Route path="/audit" element={<Navigate to="/security" replace />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      {keepSsh ? (
        // 換頁不斷線:見上面 `keepSsh`。自己一個 Suspense —— 別頁 lazy 載入時不能連帶把它換成 Loading
        <Stack xstyle={[mainStyles.ssh, !isSshPage && mainStyles.sshAway]} aria-hidden={isSshPage ? undefined : true}>
          <Suspense fallback={<Loading />}>
            <Terminal isActive={isSshPage} />
          </Suspense>
        </Stack>
      ) : null}
      </Stack>
      {/*
        小夥伴(pet-companion-kit)。lazy:framer-motion 只有它在用,
        不要進主 chunk。viewKey 讓換頁立刻重算「這頁有沒有事在跑」。

        ⚠️ 手機上**整個元件都不渲染**:小螢幕沒有多餘
        空間放一隻會動的東西,拖曳也會跟捲動打架。判斷放在這裡而不是元件內部,
        是因為只有這樣 lazy chunk(含 framer-motion)在手機上才根本不會下載,
        元件裡的閒置偵測、10 秒一次的計時器與 GIF 的 `<img src>` 也都不會起跑。

        ⚠️ **`isMobile`(= `lib/media.ts` 的 `MOBILE_QUERY`)是這個斷點的唯一
        來源。** kit 自己 className 上的 `hidden md:block`(實作在
        `styles/pet-shim.css`)留著當第二道 —— 那條是 `min-width: 768px`、
        這條是 `max-width: 768px`,剛好 768px 寬時兩邊會同時成立,以這裡為準。
      */}
      {!isMobile && (
        <Suspense fallback={null}>
          <PetCompanion viewKey={pathname} />
        </Suspense>
      )}
      {/* 從檔案區跳到某一則之後,在那一則周圍繞一圈彩虹。
          常駐但平常不畫東西(沒在圈的時候整個 return null),純 CSS,沒有動態載入 */}
      <JumpSpotlight />
      {/* 手機版展開鈕上的「還在跑」小點。自己不畫東西,只掛屬性 */}
      <RunningNavDot />
      {/*
        常駐:找舊對話的入口只有這一個 —— ⌘K 與側邊欄的 Search 都開它。
        開關放在這一層是因為兩個入口都要動它。
      */}
      <CommandPalette isOpen={isSearchOpen} onOpenChange={setIsSearchOpen} />
      <ChangePasswordDialog isOpen={isChangingPassword} onOpenChange={setIsChangingPassword} />
      {/* 個人設定(頭像 / 字級 / 對比)。⚠️ 用 `key` 讓每次打開都重新掛載 ——
          拉桿的初始值只在掛載時從 displayPrefs 取一次,不重新掛的話
          第二次打開會看到上一次打開時的數字。 */}
      <AccountSettingsDialog
        key={isSettingsOpen ? 'open' : 'closed'}
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        username={me.username}
        displayName={me.display_name}
        avatar={me.avatar}
        onIdentityChanged={onIdentityChanged}
      />
    </AppShell>
    </MeProvider>
  );
}

export function App() {
  const mode = useThemeMode();
  const {me, loading, refresh} = useIdentity();
  /*
   * 首屏畫好了沒。**不能只看 `loading`** —— 身分回來之後還要載 `Login` /
   * `ForcePasswordChange` 的分包,那段時間外層 `Suspense` 還在 fallback。
   * 只看 `loading` 的話蓋子會在首屏還沒畫出來時就開始淡,閃只是換個地方發生。
   *
   * ⚠️ 它一旦為 true 就不再回頭,但那**不代表蓋子只蓋一次** ——
   * `booting` 是 OR,`loading` 在登入 / 登出時會被設回 `true`(見 `useIdentity`
   * 結尾監聽 `IDENTITY_CHANGED` 的那支 effect)。那時候一樣會蓋(見 `BootHandoff`)。
   */
  const [isBooted, setIsBooted] = useState(false);
  const markBooted = useCallback(() => setIsBooted(true), []);

  // adoptServerTheme 放在 App 而不是 lib/auth:auth → theme → api → auth 會形成模組循環。
  useEffect(() => {
    if (me?.username) adoptServerTheme(me.username, me.theme);
  }, [me?.username, me?.theme]);

  /*
   * 字級與對比也採用伺服器那份 —— 「跟著人走」的那一半(換一台電腦、
   * 或共用電腦時,localStorage 記到的是這台機器上一個人的設定)。
   * ⚠️ `adoptServerPrefs` 刻意**不會再寫回伺服器**,不然每次開頁面都會多一次
   * 沒必要的 PUT(跟 adoptServerTheme 同一個坑)。
   */
  useEffect(() => {
    if (me?.username) adoptServerPrefs(me.font_scale, me.contrast);
  }, [me?.username, me?.font_scale, me?.contrast]);

  /*
   * 常用模型同上(存在同一張 user_prefs,只是不經過 displayPrefs 的 apply()——
   * 它不是畫面設定,見 `lib/modelPref.ts` 開頭)。
   */
  useEffect(() => {
    if (me?.username) adoptServerModel(me.preferred_model);
  }, [me?.username, me?.preferred_model]);

  /* 吉祥物同上(`lib/companionPref.ts`)。 */
  useEffect(() => {
    if (me?.username) adoptServerCompanion(me.companion);
  }, [me?.username, me?.companion]);
  useEffect(() => {
    if (me?.username) adoptServerBlobShape(me.companion_shape);
  }, [me?.username, me?.companion_shape]);
  useEffect(() => {
    if (me?.username) adoptServerBlobColor(me.companion_color);
  }, [me?.username, me?.companion_color]);

  /*
   * 把自己併進同事名冊 —— `/api/shareable-users` 刻意不含自己,不併的話
   * 共用名單裡一整排同事都有照片、只有你自己是縮寫。
   * ⚠️ 依賴要含 `me.avatar`:換完頭像後 `refresh()` 會帶回新的 data URI,
   * 少了它側邊欄那顆要等下次重新整理才換。
   */
  useEffect(() => {
    if (me?.username) {
      registerSelf({username: me.username, display_name: me.display_name, avatar: me.avatar});
    }
  }, [me?.username, me?.display_name, me?.avatar]);

  return (
    <Theme theme={neutralTheme} mode={mode}>
      <LayerProvider>
        {/* 全站提示的那一疊(lib/toast.ts 的佇列,畫成跟附件卡同一張,見 NoticeStack.tsx)。
            掛在 Theme 裡面 —— 掛外面吃不到 token,深色模式下會是一塊白的。
            未登入也要有:登入失敗以外的動作(改密碼、登出)一樣會報。 */}
        <NoticeStack />
        {/* 選單裡那塊會滑的高亮,一份管全站(見 MenuHighlightLayer.tsx 的說明)。
            掛在這裡是因為它是**委派**的:自己在 document 上聽,
            畫的時候 portal 進當下那個選單面板。 */}
        <MenuHighlightLayer />
        {/* 渲染錯誤要看得到一句話與一顆「重新整理」,不是一片全白 */}
        <ErrorBoundary>
        <Router>
          <LinkProvider component={AppLink}>
            {/* 上版之後把這個分頁帶到新版去(lib/appVersion.ts)。
                ⚠️ 位置有兩個條件:要在 `Theme` 底下(它的提示要吃 token),
                也要在 `Router` **裡面**(它要 useLocation() 兜住那十幾處
                不經過 AppLink 的程式化導覽)。掛在 Suspense 外面則是為了讓
                未登入的登入頁也偵測 —— 那一頁一樣會被開著過夜。 */}
            <UpdateWatcher />
            {/* 載入畫面在這裡,**不在 `Suspense` 裡面** —— 它要跟首屏疊著活一段時間,
                放進去的話 Suspense 一解開它就跟著不見,等於沒有交棒。
                蓋在上面靠的是 `zIndex: 90`(它是 fixed 的,首屏那棵樹沒有 z-index),
                所以寫在 `Suspense` 前面或後面都一樣。 */}
            <BootHandoff booting={loading || !isBooted} />
            {/* 這個 fallback 真正要接的是「蓋子已經淡完、但分包還沒到」那一格 —— 例如第一次登入之後
                跳去 `ForcePasswordChange`(`isBooted` 早就是 true,蓋子立刻就走)。沒有它那一格是一片空白;
                那一格看得到,所以是風。
                ⚠️ **開機那段(`!isBooted`)它會被蓋子壓在底下**:`loading` 為真時 children 是 `null` 不會 suspend,
                但 `/me` 回來之後、未登入的人等 Login 分包那一下會 suspend —— 那時蓋子還在上面,
                這裡再開一顆 renderer 誰都看不到,所以開機前不開場景。 */}
            <Suspense fallback={<Loading isFullPage hasScene={isBooted} />}>
              {loading ? null : (
                <>
                  <BootReady onReady={markBooted} />
                  {!me ? (
                    <Login />
                  ) : me.password_is_default ? (
                    <ForcePasswordChange />
                  ) : (
                    <Chrome me={me} onIdentityChanged={refresh} />
                  )}
                </>
              )}
            </Suspense>
          </LinkProvider>
        </Router>
        </ErrorBoundary>
      </LayerProvider>
    </Theme>
  );
}
