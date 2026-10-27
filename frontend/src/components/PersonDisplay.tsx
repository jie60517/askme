/**
 * **帳號 → 畫面上的那個人。** 全站顯示同事身分的三個出口都在這裡:
 *
 *   `MentionedText` —— 便條內文裡的 `@帳號`,藍色膠囊
 *   `PersonAvatar`  —— 訊息旁邊的頭像
 *   `PersonCard`    —— 上面兩個滑過去時跳出來的那張卡
 *
 * ⚠️ **三個出口對同一個帳號必須給出同一個名字。** 只要有兩個地方各自解析,
 * 就會出現「其中一個沒對齊」(膠囊寫「@陳小明」、卡片標題卻是「ming」)。
 *
 * 所以規矩是**結構性的,不是靠人記得**:畫面上每一個人名都出自
 * `personLabel()` 這一支(一律查名冊,訊息自帶的名字只是 `fallbackName`),
 * 呼叫端不准自己組。
 *
 * ⚠️ **為什麼不放在 `Chat.tsx`**:放在那裡就測不了 ——
 * 那個檔案很大、連著整組元件的 StyleX transform,在 jsdom 裡光是 import
 * 就會讓 vitest 的 worker 逾時。測試在
 * `__tests__/PersonDisplay.test.tsx`,三個出口各自守住。
 *
 * ⚠️ **新增 `<PersonCard>` 呼叫點時一定要傳 `fallbackName`。**
 */
import * as stylex from '@stylexjs/stylex';

import {Avatar, type AvatarSize} from '@astryxdesign/core/Avatar';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {Item} from '@astryxdesign/core/Item';
import {Text} from '@astryxdesign/core/Text';

import {personName} from '../lib/people';
import {allPeople, avatarOf, displayNameOf, roleOf} from '../lib/peopleDirectory';
import {avatarTint} from './avatar-colors';

const styles = stylex.create({
  /**
   * 便條裡的換行照原樣顯示(多餘的空白照樣合併)。不加的話換行被吃成空白,
   * 多行的通知與手打的多行便條會擠成一整串。
   */
  keepBreaks: {whiteSpace: 'pre-line'},
  /**
   * 對話裡那顆 @ 膠囊的行內包裝。
   * ⚠️ `inline-flex` 是關鍵:少了它 Badge 會撐成一整行(泡泡內容是 flex column)。
   */
  mentionPill: {
    display: 'inline-flex',
    /*
     * ⚠️ `verticalAlign: middle` 會讓膠囊的**整個高度**參與行高計算,
     * 於是有 @ 的那一行變得比別行粗,而且膠囊跟旁邊的字看起來沒有對齊。
     *
     * 所以貼 `baseline` 對齊(膠囊裡的字跟句子裡的字站在同一條基線上),
     * 並且用 `lineHeight: 1` + 負的上下 margin 把膠囊自己的高度從行高裡扣掉,
     * 讓它像一個字一樣不撐開行。
     */
    verticalAlign: 'baseline',
    lineHeight: 1,
    marginBlock: 'calc(var(--spacing-1) * -1)',
  },
});

/**
 * @ 到的人那顆藍色 token(輸入框與便條泡泡共用)。
 * 樣式是設計系統的預設(Badge blue),不要改它;「會通知誰」那條提示
 * 是另一個東西(見 composer 的 drawer)。
 */
export function mentionToken(username: string, displayName: string) {
  return {
    // value 一定是 @帳號:送出的字串就是它,後端拿帳號比對(不要放顯示名稱)
    value: `@${username}`,
    label: `@${personName(displayName || username)}`,
    /*
     * 訊息自己帶的顯示名稱,**原封不動**。浮層要的是這個,不是 `label` ——
     * `label` 前面有 `@`、而且已經過了 `personName`,拿它當 `fallbackName`
     * 會變成「@@名字」再被截一次。
     *
     * ⚠️ 有了它 `MentionedText` 才傳得出 `fallbackName`。少了那一步,膠囊印
     * `@陳小明`、滑上去的卡片印 `ming` —— 名冊查不到那個人(離職、或名冊還
     * 沒載完)時就會發生,而那正是 `fallbackName` 存在的唯一理由。
     */
    name: displayName,
    variant: 'blue' as const,
  };
}

/**
 * 帳號 → 畫面上該印的名字。浮層的標題與 `Avatar` 的縮寫都走這一條。
 *
 * ⚠️ **一律以 `peopleDirectory` 為準**,呼叫端傳進來的名字只是退路 ——
 * 這是「膠囊與頭像講同一個人」的唯一保證:膠囊那一路傳帳號、頭像那一路
 * 傳 `displayName || username` 的話,膠囊上寫「@陳小明」、滑上去的卡片標題
 * 卻是「ming」。
 *
 * `fallbackName` 只在名冊查不到那個人時用得到(離職、或名冊還沒載完);
 * 那時候訊息自己帶的 `author_name` 比帳號好看。
 */
export function personLabel(username: string, fallbackName?: string | null): string {
  return personName(displayNameOf(username) || fallbackName || username);
}

/**
 * 滑過去看到的「這個人是誰」。**頭像跟 @ 膠囊共用這一份**,兩邊要長得一樣。
 *
 * 內容照 @ 挑選浮層那一列:同一顆 `Item density="compact"`、同一組
 * label/description。⚠️ 外層**不要再包一層有內距的 Stack**:`Item` 自己就有
 * 內距,再包一層周圍就會空出一大圈。
 *
 * ⚠️ **`username` 一律是帳號,不是顯示名稱** —— 見 `personLabel`。
 * 同一個元件不保證同一個答案,同一份**輸入**才保證。
 */
export function PersonCard({username, fallbackName}: {username: string; fallbackName?: string | null}) {
  const label = personLabel(username, fallbackName);
  return (
    <Item
      density="compact"
      label={label}
      // 撞名的話職稱後面補帳號 —— 跟 @ 選單那一列同一條規則(見 personDescription)
      description={personDescription(allPeople(), username, label, roleOf(username)) ?? ''}
    />
  );
}

/** 撞名比對用的鍵:畫面上印的名字(`personName` 只動第一個字)不分大小寫。 */
function nameKey(name: string): string {
  return personName(name).trim().toLowerCase();
}

/**
 * `sharedNames()` 的快取,以名冊陣列本身為鍵。名冊(`allPeople()` / `mentionablePeople()`)
 * 沒變就是同一個參考,所以每張卡、每一列查的都是同一份,不會每畫一次就重數一遍。
 */
const sharedNamesCache = new WeakMap<readonly object[], ReadonlySet<string>>();

/** 名冊裡**不只一個人**在用的顯示名稱(`nameKey` 過的)。 */
function sharedNames(people: readonly {username: string; display_name?: string | null}[]): ReadonlySet<string> {
  let shared = sharedNamesCache.get(people);
  if (!shared) {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const p of people) {
      const key = nameKey(p.display_name || p.username);
      if (seen.has(key)) dup.add(key);
      else seen.add(key);
    }
    shared = dup;
    sharedNamesCache.set(people, shared);
  }
  return shared;
}

/**
 * 名字底下那一行(職稱)。**名冊裡有人同名的話,後面補 `· @帳號`。**
 *
 * 兩位「陳怡君」職稱也相同的話,@ 選單裡兩列、滑上去的卡片
 * 都一模一樣 —— 很容易 @ 錯人、通知送錯人,而畫面上沒有任何東西分得出來。
 * 帳號是唯一的,補上它就分得開;不撞名的人不補,免得每一列都多一截雜訊。
 *
 * @ 選單(`MentionList`)與 `PersonCard` 共用這一支:同一個人在兩邊的副標要一樣。
 *
 * 兩邊比的都是含自己的整份名冊(`allPeople()`):同事跟我同名時,同事那一列 / 那張卡也要補帳號,
 * 而且同一個人在兩邊的副標要一樣。@ 選單另外併上它自己的名單(名冊外的人也要互相比到),
 * 見 `MentionList`。
 */
export function personDescription(
  people: readonly {username: string; display_name?: string | null}[],
  username: string,
  shownName: string,
  role: string | undefined,
): string | undefined {
  if (!sharedNames(people).has(nameKey(shownName))) return role;
  return role ? `${role} · @${username}` : `@${username}`;
}


/**
 * 便條內文,把 `@帳號` 換成藍色膠囊,而且**滑過去看得到那個人是誰**。
 *
 * ⚠️ **不用設計系統的 `ChatTokenizedText`**,雖然它做的正是「把 @ 換成 Badge」:
 * 它的 token 只收 `value / label / variant / icon`,**沒有給每個 token 掛浮層的
 * 插槽** —— 而這裡要的就是滑過去顯示職稱。膠囊本身仍然是設計系統的
 * `Badge`(同一個 `variant="blue"`),所以長相跟 `ChatTokenizedText` 一模一樣,差別只在多了浮層。
 *
 * 切法:把所有 token 的 `value`(`@帳號`)組成一條正規式,用它切開原文,
 * 中的片段畫成膠囊、其餘照原樣輸出。**長的排前面**,不然 `@ming` 會先吃掉
 * `@ming2` 的前半截,剩一個孤零零的 `2` 掛在膠囊後面。
 */
export function MentionedText({
  text,
  tokens,
}: {
  text: string;
  tokens: Array<{value: string; label: string; name?: string}>;
}) {
  if (tokens.length === 0) {
    return (
      <Text type="body" xstyle={styles.keepBreaks}>
        {text}
      </Text>
    );
  }

  const byValue = new Map(tokens.map((t) => [t.value, t]));
  const pattern = [...byValue.keys()]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  /*
   * ⚠️ **前後都要有邊界**:只有 `(@chen)` 的話,有個帳號 chen 時,
   * 內文裡的 `a@chenwang.example.com` 會把 `@chen` 做成膠囊、後面掛著孤零零的 `wang.example.com`。
   * 兩條邊界跟 `lib/mentions.ts` 的 `MENTION`(= 後端 `notes._MENTION`)同一組:
   * 前面不能是 `[A-Za-z0-9_.@-]`(email 的 `a@`;中文緊貼 `請@ming` 照樣算),
   * 後面不能再接帳號字元 `[A-Za-z0-9_-]`(帳號字元集見後端 `ids.NAME`)。
   * 送出時後端就是照這條判誰被 @ 到的,畫面上的膠囊不該比它認得更多。
   * lookaround 不佔捕獲群組,`split` 吐出來的仍然只有中間那一段。
   */
  const parts = text.split(new RegExp(`(?<![A-Za-z0-9_.@-])(${pattern})(?![A-Za-z0-9_-])`, 'g'));

  /*
   * ⚠️ **整段一定要包在一個 `Text` 裡**。
   *
   * 原因:`ChatMessageBubble` 的內容是 **flex column**,所以直接把一串 span 與
   * Badge 丟進去,每一個都變成一列 —— 一個 @ 佔一整行、還撐成滿版。
   * 包一層 `Text` 之後裡面就是正常的行內文字流:字排滿了才換行,@ 膠囊跟著
   * 排在字中間。(`ChatTokenizedText` 自己有這一層,自己畫就要自己包。)
   */
  return (
    <Text type="body" xstyle={styles.keepBreaks}>
      {parts.map((part, i) => {
        const token = byValue.get(part);
        if (!token) return <span key={i}>{part}</span>;
        const username = part.slice(1); // 去掉開頭的 @
        return (
          <HoverCard
            key={i}
            delay={120}
            placement="above"
            label={`About ${personLabel(username, token.name)}`}
            hasHoverIndication={false}
            /*
             * 浮層的內容**跟 @ 挑選浮層裡那一列一模一樣**:同一個 `Item density="compact"`、同一組
             * label/description(名字 / 職稱)、同一份面板內距 ——
             * 兩邊是同一個問題的答案,不該長得不一樣。
             */
            content={<PersonCard username={username} fallbackName={token.name} />}
          >
            {/*
              ⚠️ 這層 span 是**必要的**,不是包好看的:`HoverCard` 的觸發元素
              要收得了 ref,而 `Badge` 沒有 `xstyle` 也不轉發 ref。
              `inline-flex` + `verticalAlign` 讓膠囊像一個字一樣排在句子裡。
            */}
            <Text as="span" xstyle={styles.mentionPill}>
              {/*
                ⚠️ **膠囊的字跟浮層的字走同一支 `personLabel()`**,不要用
                `token.label`。

                兩者平常算出來的結果一樣 —— `token.label` 來自後端的
                `note.mentioned_names`,而它跟名冊都是從 `users.list_active()`
                現算的。但那是**同源的巧合,不是結構上的保證**:名冊在前端
                快取在模組層、一個工作階段只抓一次,便條卻是每次開對話重抓,
                中間有人改了顯示名稱就會對不上,而那時膠囊與浮層會各講各的。
                讓兩邊呼叫同一支函式,就不會「膠囊寫一個名字、浮層寫另一個」。
              */}
              <Badge label={`@${personLabel(username, token.name)}`} variant="blue" />
            </Text>
          </HoverCard>
        );
      })}
    </Text>
  );
}

/**
 * 同事的頭像 + 「這個人是誰」的浮層。
 *
 * ⚠️ **只管「這顆頭像長什麼樣、代表誰」,不管它擺在哪。** 版面幾何(那個要跟
 * AI 頭像對齊的 `avatarBox` 負邊距)留在 `Chat.tsx` —— 那是聊天串的排版問題,
 * 跟「這個人是誰」無關,而且 AI 那顆也要用同一份,搬過來只會讓它跨兩個檔案。
 *
 * ⚠️ 頭像與職稱都**自己從 `peopleDirectory` 查**,不由呼叫端傳進來:
 * 從 `Chat` 穿過 `TurnProps` / `NoteBubble` 一路傳下來,就得在 `Chat` 抓第二份
 * 名冊 —— 兩份名冊、兩支請求,而且膠囊那一路與這一路解析出來的名字會不一樣。
 * 名冊只有一份。`fallbackName` 是訊息自帶的名字,只在名冊查不到那個人時才用。
 *
 * ⚠️ 用 `HoverCard` + `PersonCard`,**不要用 `Avatar` 的 `tooltip`**:
 * 那個 tooltip 只吃字串,畫出來是一條黑色小提示 —— 跟 @ 膠囊的浮層完全兩種
 * 東西。兩邊走同一個元件、同一份內容。`tooltip={false}` 一定要給,
 * 不然 Avatar 自己還會再冒一個。
 *
 * `size` 由呼叫端給:尺寸的唯一來源是 `Chat.tsx` 的 `AVATAR_PX`,那個常數
 * 同時也決定 AI 頭像與佔位格的大小,不該在這裡再寫一個。
 */
export function PersonAvatar({
  username,
  fallbackName,
  size,
}: {
  username: string;
  fallbackName?: string | null;
  size: AvatarSize;
}) {
  // 名字只算一次:標題、Avatar 的縮寫退路都用它,分開算就有機會分岔
  const label = personLabel(username, fallbackName);
  return (
    <HoverCard
      delay={120}
      placement="above"
      label={`About ${label}`}
      hasHoverIndication={false}
      content={<PersonCard username={username} fallbackName={fallbackName} />}
    >
      <Avatar
        name={label}
        src={avatarOf(username)}
        size={size}
        style={avatarTint(username)}
        tooltip={false}
      />
    </HoverCard>
  );
}
