/**
 * 登入頁。
 *
 * 版面是 Astryx `login-split` 範本 —— 左邊表單、右邊滿版圖,
 * 卡片寬度 1000、窄螢幕時兩欄併成一欄而且圖片跑到上面(靠 container query,
 * 對的是卡片寬度不是視窗寬度,所以不會跟 Grid 的斷點不同步)。
 *
 * 與範本的差別:email 欄換成帳號、沒有 SSO 鈕與分隔線、送出接 POST /api/login。
 */
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import * as stylex from '@stylexjs/stylex';

import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Card} from '@astryxdesign/core/Card';
import {Center} from '@astryxdesign/core/Center';
import {useEntryAnimation} from '@astryxdesign/core/hooks';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, Stack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';

import {Eye, EyeOff, UserKey} from 'lucide-react';

import {FieldMessage} from '../components/FieldMessage';
import {LoginScene} from '../components/LoginScene';
import {Logo} from '../components/Logo';
import {setToken} from '../lib/auth';
import {BRAND_NAME} from '../lib/brand';
import {
  describeLoginError,
  isChallenge,
  login,
  verifyMfa,
  type LoginChallenge,
  type LoginResponse,
} from '../lib/loginApi';
import {NO_AUTOFIX, type NativeInputHints} from '../lib/nativeInputHints';
import {adoptServerTheme} from '../lib/theme';


// Grid 產生的是 minmax(MIN, 1fr),MIN 是硬底線 —— MIN 加上格線內距與頁面 padding
// 必須塞得進最窄的手機,否則那一欄會被裁掉。320 − 2×24(頁面)− 2×16(併欄後內距)= 240。
const COLUMN_MIN_WIDTH = 240;

/**
 * 表單那一塊的**固定舞台高度**,讓密碼關與驗證碼關的標題落在同一條水平線上。
 *
 * 表單是垂直置中在左欄裡的,而兩關的內容高度不同 —— 置中的東西高度一變,
 * 標題就跟著上下跳。所以置中的不是內容,是一個固定高度的舞台,內容在舞台裡**靠上**。
 *
 * 280 = 桌機上第一關的內容高度(約 222,第二關更矮),
 * 再留一點給欄位底下長出來的錯誤訊息框。
 * 手機(單欄、內容撐高、沒有置中)只是多留一點下方空白,無害。
 */
const FORM_STAGE_MIN_HEIGHT = 280;

/** login-split 範本的卡片寬度。設計系統沒有「一張卡片最寬多少」的 token。 */
const CARD_MAX_WIDTH = 1000;

/**
 * 兩欄併成一欄的門檻。
 *
 * 值是算出來的:兩欄各自的硬底線 240 + 格線間距 32 = 512,
 * 所以 511 以下就一定塞不下兩欄。**改 COLUMN_MIN_WIDTH 或 gap 就要一起改這裡。**
 * StyleX 的 at-rule 鍵必須是靜態字串,沒辦法寫成 `${}`,只能靠這段註解綁住。
 */
const SPLIT_QUERY = '@container login-split (max-width: 511px)';

/*
 * 手機鍵盤的提示屬性:不然 iOS 會把帳號第一個字自動大寫、驗證碼跳出全鍵盤。
 * 為什麼要用展開傳進 `TextInput`,見 `lib/nativeInputHints.ts`。
 */

/** 帳號:不准自動大寫 / 自動校正 / 拼字紅線(帳號不是英文單字) */
const USERNAME_HINTS: NativeInputHints = {
  ...NO_AUTOFIX,
  autoComplete: 'username',
  // 帳號欄按 Enter 就是送出(`onEnter`),鍵盤上那顆鍵講「Go」
  enterKeyHint: 'go',
};

const PASSWORD_HINTS: NativeInputHints = {
  autoComplete: 'current-password',
  enterKeyHint: 'go',
  /*
   * ⚠️ 密碼欄也要關拼字 / 校正 / 自動大寫:按住眼睛時它會換成 type="text",
   * 那一刻起就是一般文字欄 —— Chrome 的拼字檢查會在密碼底下畫紅線(進階拼字檢查還會把
   * 內容送到遠端),iOS 繼續打字時會自動大寫、自動校正。
   */
  ...NO_AUTOFIX,
};

/** 驗證碼:數字鍵盤 + 讓 iOS / Android 從簡訊或驗證器帶入 */
const CODE_HINTS: NativeInputHints = {
  inputMode: 'numeric',
  autoComplete: 'one-time-code',
  enterKeyHint: 'go',
};

const styles = stylex.create({
  /** 見 FORM_STAGE_MIN_HEIGHT。VStack 預設內容靠上,這裡只補最小高度。 */
  formStage: {
    minHeight: FORM_STAGE_MIN_HEIGHT,
  },
  /**
   * 密碼欄的長按眼睛:**疊在欄位裡面的右緣**。
   * TextInput 沒有尾端插槽(v0.4.4 只有 startIcon/hasClear),
   * 所以外面包一層 relative、把 IconButton 絕對定位進去 ——
   * 欄位本身一個字沒動,聚焦/錯誤那些狀態都還是它自己的。
   */
  passwordWrap: {
    position: 'relative',
  },
  passwordEye: {
    position: 'absolute',
    insetInlineEnd: 'var(--spacing-1)',
    /*
     * ⚠️ 錨在**欄位高度的一半**,不是包裝層的 50%:
     * 錯誤訊息出現時包裝層會長高,50% 就會把眼睛擠到欄位底下。18px = lg 欄位 36px 的一半,
     * 用 token 湊:spacing-4(16)+ spacing-0-5(2)。
     */
    insetBlockStart: 'calc(var(--spacing-4) + var(--spacing-0-5))',
    translate: '0 -50%',
    zIndex: 1,
  },

  page: {
    minHeight: '100%',
    backgroundColor: 'var(--color-background-body)',
  },
  /**
   * 容器查詢的**容器**要掛在這裡,不能掛在 Grid 上:
   * 元素查不到自己所在的容器,掛在 Grid 上的話「窄的時候換內距」那條規則
   * 對 Grid 自己完全不會生效(只有它的子元素吃得到)。
   */
  cardWrap: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    marginInline: 'auto',
    containerType: 'inline-size',
    containerName: 'login-split',
  },
  // 內距要加在 grid 不是 Card:表單那側的 Section 會逃出 Card 的
  // --container-padding-*,加在 Card 上的話表單那邊的內距會被取消掉。
  splitGrid: {
    padding: {
      default: 'var(--spacing-8)',
      [SPLIT_QUERY]: 'var(--spacing-4)',
    },
  },
  splitImage: {
    width: '100%',
    // 範本這一格是一張 675x900 的圖,靠它的內在比例把整列撐到 434x579。
    // 場景沒有東西撐高度,那一列會塌成表單的高度,
    // 所以把比例釘住 —— align-self 也不能是 stretch,否則格線會覆蓋掉高度。
    alignSelf: 'start',
    aspectRatio: '3 / 4',
    // 併成一欄時圖片排到上面
    order: {default: 0, [SPLIT_QUERY]: -1},
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
});

/**
 * 一關的內容(密碼 / 驗證碼)。呼叫端用 `key` 依關卡切換,換關就是重新掛載 → 淡入。
 *
 * 舞台有固定最小高度(`FORM_STAGE_MIN_HEIGHT`),版面不會跳,所以只淡入、不位移:標題落在同一條線上
 * 正是那個固定高度要的效果,滑進來反而把它破壞掉。
 *
 * - `isAnimated`:一進頁面的第一關**不演** —— 整頁已經有 `entry` 的淡入,
 *   兩層 opacity 疊在一起只會變成一條比較慢的曲線。(`useEntryAnimation` 自己只擋
 *   「首次繪製時就在」的元素,而登入頁常常是從載入畫面接手、首次繪製之後才掛上的。)
 * - reduce motion 由 hook 自己處理。
 * - 排版(`gap={4}`、撐滿寬度)由這一層負責,舞台本身只管最小高度。
 */
function StepFade({isAnimated, children}: {isAnimated: boolean; children: React.ReactNode}) {
  const entry = useEntryAnimation('fadeIn');
  return (
    <VStack gap={4} hAlign="stretch" width="100%" xstyle={isAnimated ? entry : null}>
      {children}
    </VStack>
  );
}

export default function Login() {
  /** 從整頁的載入畫面接手過來的淡入。 */
  const entry = useEntryAnimation('fadeIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  /** 明碼切換。放這裡而不是欄位裡面的理由寫在那顆按鈕旁邊 */
  const [isPasswordShown, setIsPasswordShown] = useState(false);
  /**
   * Caps Lock 提醒。
   *
   * 帳號欄自己會把輸入轉小寫,所以打錯大小寫不會卡在帳號上 —— 會卡在密碼上,
   * 而密碼是圓點,看不出來自己按到了 Caps Lock。這是登入失敗最沒有線索的一種。
   *
   * 拆成兩個狀態,**顯示條件是兩者的 AND**(密碼欄聚焦中 × Caps Lock 開著):
   *
   * - `isCapsLockOn`:**整頁**任何鍵盤/滑鼠事件都在更新的「最後已知狀態」。
   *   ⚠️ 不能只聽密碼欄自己的按鍵:「在帳號欄打完字、用**滑鼠點**進
   *   密碼欄」會完全沒有事件可判,提示不出來(Tab 的 keyup 落在密碼欄上,
   *   點選沒有任何按鍵)。在 document 上聽:打帳號的每一個字、頁面上
   *   任何一次 mousedown 都帶著 `getModifierState`,所以點進密碼欄的
   *   **那一下**本身就把狀態帶進來了。
   * - `isPasswordFocused`:提示只在密碼欄聚焦時畫,切到帳號欄就消失 ——
   *   狀態照記,只是不畫;切回來立刻接上,
   *   不必再等一次按鍵。
   *
   * ⚠️ `getModifierState` 只存在於輸入事件上,沒有 API 可以主動查 ——
   * 頁面載入後一個事件都還沒發生時我們就是不知道,那是瀏覽器的限制。
   * keydown 與 keyup 都聽(按下 Caps Lock 那一下,各家瀏覽器回報切換前
   * 還是切換後並不一致,兩邊都聽才收斂)。
   */
  const [isCapsLockOn, setIsCapsLockOn] = useState(false);
  const [isPasswordFocused, setIsPasswordFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * 第二關。非 null = 密碼已經對了,現在等驗證碼。
   *
   * 用一個 state 同時當「要不要顯示第二關」與「那張中間憑證」——
   * 兩件事本來就是同一件,拆成兩個 state 只會出現「顯示著第二關但憑證是空的」
   * 這種對不起來的中間狀態。
   */
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  /**
   * 這個頁面裡**換過關**沒有(密碼 → 驗證碼,或按上一頁退回來)。只有換過關之後才淡入,
   * 見 `StepFade` 的說明;一進頁面的第一關已經跟著整頁的 `entry` 淡進來了。
   */
  const [hasSwitchedStep, setHasSwitchedStep] = useState(false);
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  /**
   * 登入成功的收尾。兩條路徑(只有密碼 / 密碼 + 驗證碼)共用同一份。
   *
   * 三件事,順序有講究:
   *
   * 1. **先套佈景**:`setToken` 會廣播並換畫面,順序反了會看到畫面亮著一整個往返。
   * 2. **把網址退回 `/`**:登入後一律從新對話開始。
   *    ⚠️ 少了這一步,**瀏覽器自己記得的網址**會把人帶回舊對話:上一次停在 `/c/abc`,
   *    關掉、再打開(或用「回復上次工作階段」),網址還是 `/c/abc`;token 存
   *    sessionStorage 所以要重新登入,登入完成後 `App` 直接照那個網址掛上 Chat。
   *
   *    修在**這裡**而不是「每次開頁就導回 /」:後者會連「在新分頁開別人分享的
   *    連結」與「在某組對話按 F5」一起打斷,而那兩件是對的行為。真正該重來的
   *    只有「重新登入」這一刻。
   * 3. 最後才存 token。
   */
  const signIn = (username: string, theme: LoginResponse['theme'], token: string) => {
    adoptServerTheme(username, theme);
    navigate('/', {replace: true});
    setToken(token);
  };

  useEffect(() => {
    const track = (e: KeyboardEvent | MouseEvent) => {
      // 非實體鍵盤(手機軟鍵盤、部分 IME)拿不到修飾鍵狀態時會回 false,
      // 提示就跟著收掉 —— 那些裝置本來也沒有 CapsLock 可言
      setIsCapsLockOn(e.getModifierState('CapsLock'));
    };
    document.addEventListener('keydown', track, true);
    document.addEventListener('keyup', track, true);
    // mousedown 也帶 getModifierState:點進密碼欄的那一下就是判斷的時機
    document.addEventListener('mousedown', track, true);
    return () => {
      document.removeEventListener('keydown', track, true);
      document.removeEventListener('keyup', track, true);
      document.removeEventListener('mousedown', track, true);
    };
  }, []);

  const handleLogin = async () => {
    if (isLoading) return;
    // 空欄位不要用 disabled 擋:按鈕一灰掉就不是設計稿上那顆黑的了。
    // 改成按下去才驗,跟範本一樣把錯誤講在欄位上。
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      if (isChallenge(result)) {
        // 密碼對了,但還沒登入。**這裡不能碰 setToken** —— 那張 mfa_token
        // 不是 token(見 loginApi.isChallenge)。
        setChallenge(result);
        setHasSwitchedStep(true);
        setCode('');
        setIsLoading(false);
        return;
      }
      signIn(result.username, result.theme, result.token);
    } catch (err) {
      setError(describeLoginError(err));
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    if (isLoading || !challenge) return;
    if (!code.trim()) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const me = await verifyMfa(challenge.mfa_token, code.trim());
      signIn(me.username, me.theme, me.token);
    } catch (err) {
      setError(describeLoginError(err));
      setIsLoading(false);
      // 打錯就清空欄位:那六個數字每 30 秒就換一組,留著上一次打的只會讓他
      // 在原地改字,而正確的動作是重看手機再打一次。
      setCode('');
    }
  };

  /** 回到第一關。只有一條路會走到這裡:瀏覽器的「上一頁」(見下面那個 effect)。 */
  const restart = () => {
    setChallenge(null);
    setHasSwitchedStep(true);
    setCode('');
    setPassword('');
    setError(null);
  };

  /*
   * 第二關是**一筆瀏覽歷史**:要換帳號就按瀏覽器的上一頁,畫面上沒有「換帳號」按鈕。
   *
   * 進入第二關就 pushState 一筆(網址不變);使用者按上一頁 → popstate → 回到
   * 第一關。
   *
   * ⚠️ 只在 `challenge` 從無到有時 push 一次;通過第二關時 `signIn` 是
   * `navigate('/', {replace: true})`,正好把這一筆蓋掉,登入後按上一頁不會退回
   * 一個空的第二關。
   * ⚠️ 監聽只掛在第二關期間(cleanup 會拆),第一關按上一頁就是離開這個站,
   * 那是瀏覽器本來的行為,不攔。
   */
  useEffect(() => {
    if (!challenge) return;
    // StrictMode 會把 effect 跑兩次;同一關只該有一筆,不然要按兩次上一頁
    if (window.history.state?.loginStep !== 'mfa') {
      window.history.pushState({loginStep: 'mfa'}, '');
    }
    // 只認「往回」:退到第二關那筆之外才算離開;往前(forward)回到這一筆不動
    const onPopState = () => {
      if (window.history.state?.loginStep !== 'mfa') restart();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // restart 只碰 setState,識別在整個生命週期裡穩定;相依只看 challenge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge]);

  /*
   * 登入頁一掛上就把網址退回 `/`,登入後一律從新對話開始。
   *
   * 這是第三條路:`auth.resetRestoredSessionToNewChat` 管「token 還在、不經登入頁」,
   * `signIn` 管「登入那一刻」;而**登入頁本身**還可能掛在 `/c/abc` 上 —— 瀏覽器
   * 回復了舊網址但 token 已經過期。不退的話,第二關 `pushState` 之後那筆底下的
   * 歷史還是 `/c/abc`,登入後按上一頁會帶著有效 token 落回舊對話。
   * 在這裡退,底下那筆就是 `/`。
   *
   * ⚠️ 這也表示「沒登入的人開別人分享的連結,登入後不會被導回那個連結」——
   * 這是刻意的行為,不是漏掉。
   */
  useEffect(() => {
    if (window.location.pathname !== '/') navigate('/', {replace: true});
  }, [navigate]);

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleLogin();
  };

  const onEnterVerify = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleVerify();
  };

  return (
    <Center axis="both" padding={6} xstyle={[styles.page, entry]}>
      <VStack gap={4} width="100%">
        <Stack xstyle={styles.cardWrap}>
          <Card padding={0} width="100%">
            <Grid
              columns={{minWidth: COLUMN_MIN_WIDTH, repeat: 'fit'}}
              gap={8}
              align="stretch"
              xstyle={styles.splitGrid}
            >
              {/* 表單 */}
              <Section variant="transparent" padding={0} height="100%">
                <VStack gap={4} height="100%">
                  <HStack gap={2} vAlign="center">
                    <Logo size={20} />
                    <Text type="body" weight="bold">
                      {BRAND_NAME}
                    </Text>
                  </HStack>

                  <StackItem size="fill">
                    <Center axis="vertical" height="100%">
                      <VStack gap={4} hAlign="stretch" width="100%" xstyle={styles.formStage}>
                        {/*
                          第二關。**整個第一關的欄位都不留在畫面上** ——
                          留著的話使用者會以為要重打一次帳密,而那兩欄現在
                          什麼也不做(密碼已經驗過了,憑證在 challenge 裡)。
                        */}
                        {challenge ? (
                          <StepFade key="mfa" isAnimated={hasSwitchedStep}>
                            <VStack gap={1}>
                              <Text type="display-1" as="h1">
                                Two-step verification
                              </Text>
                              <Text type="body" color="secondary" size="sm">
                                Enter the 6-digit code from your authenticator app for{' '}
                                {challenge.username}.
                              </Text>
                            </VStack>

                            <Stack {...{'data-has-field-message': ''}}>
                              <TextInput
                                label="Verification code"
                                isLabelHidden
                                placeholder="000000"
                                value={code}
                                onChange={(value: string) => {
                                  setCode(value);
                                  setError(null);
                                }}
                                size="lg"
                                status={error ? {type: 'error'} : undefined}
                                onKeyDown={onEnterVerify}
                                /*
                                  數字鍵盤靠 `inputMode="numeric"`(在 CODE_HINTS 裡)——
                                  設計系統的 TextInput 只在**型別上**沒開放它,執行期會攤到
                                  `<input>`,見 `lib/nativeInputHints.ts` 的說明。
                                  **不要改成 `type="number"`** 去湊 ——
                                  那會把開頭的 0 吃掉(`012345` 變成 `12345`),
                                  而六位數的碼有十分之一機會是 0 開頭。
                                */
                                {...CODE_HINTS}
                                hasAutoFocus
                              />
                              {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
                            </Stack>

                            <Button
                              label="Verify"
                              variant="primary"
                              size="lg"
                              isLoading={isLoading}
                              onClick={() => void handleVerify()}
                            />
                          </StepFade>
                        ) : (
                          <StepFade key="password" isAnimated={hasSwitchedStep}>
                        <VStack gap={1}>
                          <Text type="display-1" as="h1">
                            Welcome back
                          </Text>
                          <Text type="body" color="secondary" size="sm">
                            Login to your {BRAND_NAME} account
                          </Text>
                        </VStack>

                        <VStack gap={2}>
                          <TextInput
                            label="Username"
                            isLabelHidden
                            placeholder="Username"
                            value={username}
                            // 帳號一律小寫:主機上的帳號是小寫的,大小寫混著打會登不進去。
                            onChange={(value: string) => {
                              setUsername(value.toLowerCase());
                              setError(null);
                            }}
                            size="lg"
                            onKeyDown={onEnter}
                            {...USERNAME_HINTS}
                          />
                          {/*
                            長按才看得到明碼:按住 → text,放開/移開 → password。
                            點一下不切換 —— 想「按一下看、忘了關」的那種外流不會發生。
                            ⚠️ 只有 icon 沒有字;可及名稱在 aria-label,
                            `aria-pressed` 讓報讀軟體講得出「現在是明碼」。
                          */}
                          {/* data-has-field-message:藏欄內 ⓧ(global.css);data-password-wrap:onBlur 判斷焦點有沒有離開這一塊 */}
                          <Stack xstyle={styles.passwordWrap} {...{'data-has-field-message': '', 'data-password-wrap': ''}}>
                            <TextInput
                              label="Password"
                              isLabelHidden
                              placeholder="Enter your password"
                              type={isPasswordShown ? 'text' : 'password'}
                              value={password}
                              onChange={(value: string) => {
                                setPassword(value);
                                setError(null);
                              }}
                              size="lg"
                              /*
                                ⚠️ **只給 type 不給 message**:紅框仍由設計系統上,
                                但訊息框自己畫(見 components/FieldMessage.tsx 的說明 ——
                                設計系統的 attached 訊息不畫最左邊那顆 ✕ 前導圖示)。
                                message 給了它會畫出**第二個**框。
                              */
                              status={error ? {type: 'error'} : undefined}
                              onKeyDown={onEnter}
                              {...PASSWORD_HINTS}
                              onFocus={() => setIsPasswordFocused(true)}
                              /*
                                離開密碼欄就把 Caps Lock 提示收掉(見 isCapsLockOn
                                的說明)。⚠️ 焦點只是跑到**同一塊裡面**的眼睛鈕
                                (長按看明碼,它就疊在欄位右緣)不算離開 ——
                                不擋的話「按一下眼睛」會順手把提示弄不見,
                                而使用者根本沒換欄位。
                                `relatedTarget` 是 null(點到空白處)時照樣收掉。
                              */
                              onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                                const next = e.relatedTarget as Node | null;
                                const field = e.currentTarget.closest('[data-password-wrap]');
                                if (next && field?.contains(next)) return;
                                setIsPasswordFocused(false);
                              }}
                            />
                            <Stack xstyle={styles.passwordEye}>
                              <IconButton
                                label="Hold to show the password"
                                variant="ghost"
                                size="sm"
                                icon={isPasswordShown ? <Icon icon={EyeOff} size="sm" /> : <Icon icon={Eye} size="sm" />}
                                aria-pressed={isPasswordShown}
                                onPointerDown={() => setIsPasswordShown(true)}
                                onPointerUp={() => setIsPasswordShown(false)}
                                onPointerLeave={() => setIsPasswordShown(false)}
                                onPointerCancel={() => setIsPasswordShown(false)}
                                // 鍵盤等價:按住 Space/Enter 顯示,放開藏 ——
                                // 只有 pointer 的話鍵盤使用者永遠看不到明碼
                                onKeyDown={(e: React.KeyboardEvent) => {
                                  if (e.key === ' ' || e.key === 'Enter') setIsPasswordShown(true);
                                }}
                                onKeyUp={() => setIsPasswordShown(false)}
                                onClick={(e: React.MouseEvent) => e.preventDefault()}
                              />
                            </Stack>
                            {/*
                              欄位底下的訊息框(從 INPUT 往下長的那種,見
                              components/FieldMessage.tsx)。**一定要放在 passwordWrap 裡面**:
                              外面那層 VStack 有 gap,負的 marginTop 會被 gap 吃掉,
                              框就接不到欄位上。
                              錯誤優先;沒有錯誤、密碼欄聚焦中、Caps Lock 開著,
                              才輪到藍色那則(一行字)。
                              `role`:錯誤本身已有頁尾那個 VisuallyHidden 的
                              role="alert" 在播,這裡不再標(標了會唸兩次);
                              Caps Lock 那則掛 role="status" 讓報讀軟體唸一次。
                            */}
                            {error ? (
                              <FieldMessage tone="error">{error}</FieldMessage>
                            ) : isPasswordFocused && isCapsLockOn ? (
                              <FieldMessage tone="info" role="status">
                                Caps Lock is on
                              </FieldMessage>
                            ) : null}
                          </Stack>
                        </VStack>

                        <Button
                          label="Login"
                          variant="primary"
                          size="lg"
                          isLoading={isLoading}
                          onClick={() => void handleLogin()}
                        />
                          </StepFade>
                        )}
                      </VStack>
                    </Center>
                  </StackItem>

                  <VStack gap={0.5} hAlign="start">
                    <Text type="supporting" color="secondary">
                      Don&apos;t have an account or having trouble signing
                      in{'\u00a0'}?
                    </Text>
                    {/*
                      ⚠️ 這是**純顯示,不是連結**。不要用 `<Link href="#">` 配
                      底線掃出來 + 箭頭往右推的 hover —— 那些都是「點了會去某處」
                      的暗示,而它哪裡都不去。
                      要它真的能點的時候再改成 Link,不要只加箭頭。
                    */}
                    <HStack gap={1} vAlign="center">
                      <Text type="supporting">Ask Admin</Text>
                      <Icon icon={UserKey} size="sm" />
                    </HStack>
                  </VStack>
                </VStack>
              </Section>

              {/* 右欄 —— 範本放圖的位置,這裡是 three.js 的互動場景(每次重新整理換一款)。
                  尺寸完全沿用圖片那個格子:透明的 Card 一樣會把它裁成圓角。 */}
              <Stack xstyle={styles.splitImage}>
                <Card variant="transparent" padding={0} width="100%" height="100%">
                  <Stack xstyle={styles.coverImage}>
                    <LoginScene />
                  </Stack>
                </Card>
              </Stack>
            </Grid>
          </Card>
        </Stack>
      </VStack>

      {/* 錯誤訊息也要播報一次:TextInput 的 status 不保證是 live region。 */}
      <VisuallyHidden as="div" role="alert">
        {error ?? ''}
      </VisuallyHidden>
    </Center>
  );
}
