// @vitest-environment jsdom
/**
 * 「@ 膠囊上的名字」與「滑上去那張卡片上的名字」**必須是同一個人**。
 *
 * 規則是:`PersonCard` **只收帳號**,名字一律由名冊解析,訊息自帶的名字降級成
 * `fallbackName`。而通往它的路有**兩條** ——
 * 膠囊那一路(`MentionedText`)與頭像那一路(`PersonAvatar`)。
 *
 * 危險就在這裡:`fallbackName` 是選用的,所以**其中一條路忘了傳也編得過**。
 * 症狀是膠囊寫「@陳小明」、浮層寫「ming」—— 同一個人在同一個畫面上兩個名字。
 *
 * 型別擋不住
 * (`fallbackName` 是選用的)、`tsc` 不會說話、純函式測試也照不到 —— 只有真的
 * 把元件渲染出來、看畫面上印什麼字才抓得到。
 *
 * ⚠️ 測的是**畫面上的字**,不是實作。`personLabel` 怎麼寫、`PersonCard` 收幾個
 * prop 都可以改;不能改的是「兩個地方印出同一個人」。
 *
 * ⚠️ **浮層關著的時候內容不在 DOM 裡**(`useLayer` 只留一個 inert 的
 * `<template>`),`label` 也還沒掛上去 —— 所以每一條都要先 hover。
 * 在 jsdom 裡走的是 `useLayer` 那條「沒有 showPopover 就 `display:block`」的
 * 退路(Firefox <125 也是走這條),所以浮層真的會出現。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * 名冊直接 mock 掉:這裡要驗的是「查得到 / 查不到時各退回哪個名字」,
 * 用真的名冊還得繞一圈去攔 API,而那跟這個元件無關。
 */
const displayNameOf = vi.fn();
const roleOf = vi.fn();
const avatarOf = vi.fn();
type Person = {username: string; display_name?: string; role?: string};
const NOBODY: Person[] = [];
/** 名冊(撞名判斷用;卡片走 `allPeople()`)。預設空的 = 沒有人撞名。 */
let mentionable: Person[] = NOBODY;

vi.mock('../../lib/peopleDirectory', () => ({
  mentionablePeople: () => mentionable,
  allPeople: () => mentionable,
  displayNameOf: (u: string) => displayNameOf(u),
  roleOf: (u: string) => roleOf(u),
  avatarOf: (u: string) => avatarOf(u),
  /*
   * ⚠️ 這一支是 `avatar-colors` 的 `avatarTint()` 在用的(頭像底色照名冊位置分),
   * 不是這裡直接呼叫的 —— 但 mock 掉整個模組就得**連它一起給**,少了它
   * `PersonAvatar` 會在 render 當場炸,而錯誤訊息指向 avatar-colors.ts,
   * 看起來完全不像「測試的 mock 少寫一支」。
   * 回 undefined = 名冊還沒載完,配色退回名字雜湊,那是正常路徑。
   */
  rosterIndexOf: () => undefined,
}));

const {MentionedText, PersonAvatar, mentionToken} = await import('../PersonDisplay');
const {MentionList} = await import('../MentionList');

beforeEach(() => {
  displayNameOf.mockReset();
  roleOf.mockReset();
  avatarOf.mockReset();
  roleOf.mockReturnValue('Consultant');
  avatarOf.mockReturnValue(undefined);
  mentionable = NOBODY;
});

/*
 * ⚠️ **一定要自己呼叫 `cleanup()`。** @testing-library 的自動清理只在測試框架
 * 有掛全域 afterEach 時才會跑,而這個專案的 vitest **沒有開 `globals`**
 * (`vite.config.ts` 裡沒設)—— 所以不清的話,上一條的浮層會留在 `document.body`
 * 裡,下一條的 `querySelector('[aria-label^="About "]')` 抓到的是**上一條那張卡**。
 *
 * 症狀很有欺騙性:斷言拿到的是別條測試的正確答案,所以有些條會莫名其妙地過,
 * 有些條報「expected 'About Ming' to be 'About 陳小明'」看起來像元件壞了。
 */
afterEach(cleanup);

/**
 * 渲染一則帶一顆 @ token 的便條,滑上去把浮層打開,回傳兩邊各自印了什麼。
 *
 * `username` 是帳號,`carriedName` 是**訊息自己帶的**顯示名稱
 * (後端的 `note.mentioned_names`)—— 也就是 `fallbackName` 的來源。
 */
async function openCard(username: string, carriedName: string) {
  const user = userEvent.setup();
  const {container} = render(
    <MentionedText
      text={`@${username} 你看一下`}
      tokens={[mentionToken(username, carriedName)]}
    />,
  );

  /*
   * 用 `.astryx-badge` 抓膠囊,不用 `getByText` —— 膠囊的文字同時也是它外層
   * 那個 `Text` 的全部內容,`getByText` 會一次match到兩個然後丟
   * 「Found multiple elements」。這個 class 是 Badge 對外的名字
   * (跟 `data-variant` 同一組),不是內部細節。
   */
  const pill = container.querySelector('.astryx-badge') as HTMLElement;
  expect(pill, '找不到 @ 膠囊').toBeTruthy();

  await user.hover(pill);
  // delay={120},要等它跳出來
  await waitFor(() => expect(document.querySelector('[aria-label^="About "]')).toBeTruthy(), {
    timeout: 3000,
  });

  const card = document.querySelector('[aria-label^="About "]') as HTMLElement;
  return {
    /** 膠囊上印的字,例如 `@陳小明` */
    pillText: pill.textContent,
    /** 浮層的無障礙標題,例如 `About 陳小明` */
    cardLabel: card.getAttribute('aria-label'),
    /** 浮層裡看得到的文字 */
    cardText: card.textContent ?? '',
  };
}

describe('膠囊與浮層講同一個人', () => {
  it('名冊查得到 —— 兩邊都用名冊的名字(名冊優先於訊息自帶的舊名字)', async () => {
    // 名冊說他現在叫「陳小明」,而訊息裡存的是當初的「小明」
    displayNameOf.mockReturnValue('陳小明');

    const {pillText, cardLabel, cardText} = await openCard('ming', '小明');

    expect(pillText).toBe('@陳小明');
    expect(cardLabel).toBe('About 陳小明');
    expect(cardText).toContain('陳小明');
    // 職稱也要跟著出來,那是這張卡片的另一半用途
    expect(cardText).toContain('Consultant');
  });

  /**
   * ⚠️ **這一條是最容易漏掉的 case。**
   *
   * 名冊查不到 = 那個人離職了(`/api/shareable-users` 不回他),或名冊還沒載完。
   * 那正是 `fallbackName` 存在的唯一理由 —— 少了它,浮層會一路退到最後印帳號,
   * 而膠囊仍然印訊息自帶的名字,兩邊當場對不起來。
   */
  it('名冊查不到(離職)—— 退回訊息自帶的名字,**不是**退回帳號', async () => {
    displayNameOf.mockReturnValue(undefined);

    const {pillText, cardLabel, cardText} = await openCard('ming', '陳小明');

    expect(pillText).toBe('@陳小明');
    expect(cardLabel).toBe('About 陳小明');
    expect(cardText).toContain('陳小明');
    // 壞掉的時候看到的會是這個
    expect(cardLabel).not.toBe('About Ming');
    expect(cardText).not.toContain('Ming');
  });

  it('名冊查不到、訊息也沒帶名字 —— 兩邊一起退回帳號,仍然一致', async () => {
    displayNameOf.mockReturnValue(undefined);

    // personName() 會把首字母大寫,所以 ming → Ming(兩邊都是)
    const {pillText, cardLabel} = await openCard('ming', '');

    expect(pillText).toBe('@Ming');
    expect(cardLabel).toBe('About Ming');
  });

  it('沒有職稱時浮層不會印出 undefined / null', async () => {
    displayNameOf.mockReturnValue('陳小明');
    roleOf.mockReturnValue(undefined);

    const {cardText} = await openCard('ming', '');

    expect(cardText).not.toContain('undefined');
    expect(cardText).not.toContain('null');
  });
});

describe('mentionToken 的 label 與 name 是兩個欄位', () => {
  /**
   * `label` 帶了 `@`、也已經過了 `personName`;`name` 是**原封不動**的顯示名稱。
   * 混用的話浮層會印成「@@陳小明」—— 這就是為什麼修這條時不能
   * 直接把 `token.label` 傳去當 `fallbackName`。
   */
  it('label 給膠囊看(有 @),name 給浮層當退路(沒有 @、沒有加工)', () => {
    const token = mentionToken('ming', '陳小明');

    expect(token.value).toBe('@ming'); // 送出的字串,後端拿帳號比對
    expect(token.label).toBe('@陳小明');
    expect(token.name).toBe('陳小明');
  });

  it('沒有顯示名稱時 label 退回帳號,name 維持空的(交給 personLabel 決定退路)', () => {
    const token = mentionToken('ming', '');

    expect(token.label).toBe('@Ming');
    expect(token.name).toBe('');
  });
});

/**
 * 頭像那一路。**跟膠囊那一路是同一組斷言**,而且必須是 —— 兩邊給出不同的
 * 名字正是這個缺陷本身,分開寫不同的期待等於把它放回來。
 * 兩路都測,不管哪一路被改壞都會紅。
 */
describe('頭像與浮層講同一個人', () => {
  async function openAvatarCard(username: string, carriedName: string) {
    const user = userEvent.setup();
    const {container} = render(
      <PersonAvatar username={username} fallbackName={carriedName} size={32} />,
    );

    const avatar = container.querySelector('.astryx-avatar') as HTMLElement;
    expect(avatar, '找不到頭像').toBeTruthy();

    await user.hover(avatar);
    await waitFor(() => expect(document.querySelector('[aria-label^="About "]')).toBeTruthy(), {
      timeout: 3000,
    });

    const card = document.querySelector('[aria-label^="About "]') as HTMLElement;
    return {
      /** Avatar 的無障礙名稱 / 縮寫用的那個字串 */
      avatarName: avatar.textContent ?? '',
      cardLabel: card.getAttribute('aria-label'),
      cardText: card.textContent ?? '',
    };
  }

  it('名冊查得到 —— 用名冊的名字', async () => {
    displayNameOf.mockReturnValue('陳小明');

    const {cardLabel, cardText} = await openAvatarCard('ming', '小明');

    expect(cardLabel).toBe('About 陳小明');
    expect(cardText).toContain('陳小明');
    expect(cardText).toContain('Consultant');
  });

  /** ⚠️ 跟膠囊那一路完全同一條:名冊查不到就退回訊息自帶的名字,不是退回帳號。 */
  it('名冊查不到(離職)—— 退回訊息自帶的名字,**不是**退回帳號', async () => {
    displayNameOf.mockReturnValue(undefined);

    const {cardLabel, cardText} = await openAvatarCard('ming', '陳小明');

    expect(cardLabel).toBe('About 陳小明');
    expect(cardText).toContain('陳小明');
    expect(cardLabel).not.toBe('About Ming');
  });

  it('名冊查不到、訊息也沒帶名字 —— 退回帳號', async () => {
    displayNameOf.mockReturnValue(undefined);

    const {cardLabel} = await openAvatarCard('ming', '');

    expect(cardLabel).toBe('About Ming');
  });

  /**
   * ⚠️ 頭像的圖**自己從名冊查**,不由呼叫端傳(這個值
   * 不由呼叫端一路從 `Chat` 穿過 `TurnProps` / `NoteBubble` 傳下來)。
   */
  it('頭像的圖來自名冊,不是呼叫端傳的', async () => {
    displayNameOf.mockReturnValue('陳小明');
    avatarOf.mockReturnValue('data:image/png;base64,AAA');

    const {container} = render(<PersonAvatar username="ming" fallbackName="" size={32} />);

    expect(avatarOf).toHaveBeenCalledWith('ming');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });
});

/**
 * 膠囊的邊界:跟後端 `notes._MENTION` 同一組。
 * 只比 `(@chen)` 的話,email 裡的 `@chen` 也會被做成膠囊。
 */
describe('@ 膠囊只認一個完整的 @帳號', () => {
  const pills = (text: string, username = 'chen') => {
    const {container} = render(
      <MentionedText text={text} tokens={[mentionToken(username, '')]} />,
    );
    return {
      count: container.querySelectorAll('.astryx-badge').length,
      text: container.textContent,
    };
  };

  it('email 裡的 @chen 不是提及(前後都接著帳號字元)', () => {
    const {count, text} = pills('寄到 a@chenwang.example.com');
    expect(count).toBe(0);
    expect(text).toBe('寄到 a@chenwang.example.com');
  });

  it('後面還接帳號字元的是另一個人(@chen2、@chen-li 都不是 @chen)', () => {
    expect(pills('@chen2 你看').count).toBe(0);
    expect(pills('@chen-li 你看').count).toBe(0);
    expect(pills('@chen_li 你看').count).toBe(0);
  });

  it('前面是帳號字元或 . 的不算(user@chen、x.@chen)', () => {
    expect(pills('user@chen 你看').count).toBe(0);
    expect(pills('x.@chen').count).toBe(0);
  });

  it('中文緊貼、句點、行首行尾都照樣是膠囊', () => {
    expect(pills('請@chen看一下').count).toBe(1);
    expect(pills('@chen').count).toBe(1);
    expect(pills('問一下 @chen.').count).toBe(1);
    expect(pills('@chen @chen').count).toBe(2);
  });
});

/**
 * 同名同職稱:兩位「陳怡君」職稱也相同的話,@ 選單兩列、
 * 卡片都一模一樣 —— 撞名時副標補 `· @帳號`,沒撞名的維持只有職稱。
 */
describe('撞名的人副標補上帳號', () => {
  const ROSTER: Person[] = [
    {username: 'yichun', display_name: '陳怡君', role: 'Consultant'},
    {username: 'yichun2', display_name: '陳怡君', role: 'Consultant'},
    {username: 'ming', display_name: '陳小明', role: 'Consultant'},
    // 沒有職稱也要分得開
    {username: 'amy', display_name: 'Amy', role: ''},
    {username: 'amy_w', display_name: 'amy', role: ''},
  ];

  it('@ 選單:撞名的兩列補帳號,其他列不補', () => {
    const {getAllByRole} = render(
      <MentionList
        people={ROSTER}
        groups={[]}
        query=""
        onQueryChange={() => {}}
        onPickPerson={() => {}}
        onPickGroup={() => {}}
      />,
    );
    const rows = getAllByRole('option').map((el) => el.textContent ?? '');
    expect(rows[0]).toContain('Consultant · @yichun');
    expect(rows[1]).toContain('Consultant · @yichun2');
    expect(rows[2]).toContain('Consultant');
    expect(rows[2]).not.toContain('@');
    // 大小寫不同但畫面上印出來一樣(personName 把首字母大寫)也算撞名
    expect(rows[3]).toContain('@amy');
    expect(rows[4]).toContain('@amy_w');
  });

  it('@ 選單:搜尋把另一位濾掉時,這一列的副標不會跟著變', () => {
    const {getAllByRole} = render(
      <MentionList
        people={ROSTER}
        groups={[]}
        query="yichun2"
        onQueryChange={() => {}}
        onPickPerson={() => {}}
        onPickGroup={() => {}}
      />,
    );
    const rows = getAllByRole('option').map((el) => el.textContent ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Consultant · @yichun2');
  });

  it('卡片:撞名的補帳號、沒撞名的只有職稱', async () => {
    mentionable = ROSTER;
    displayNameOf.mockImplementation((u: string) => ROSTER.find((p) => p.username === u)?.display_name);

    const user = userEvent.setup();
    const open = async (username: string) => {
      const {container, unmount} = render(<PersonAvatar username={username} fallbackName="" size={32} />);
      await user.hover(container.querySelector('.astryx-avatar') as HTMLElement);
      await waitFor(() => expect(document.querySelector('[aria-label^="About "]')).toBeTruthy(), {
        timeout: 3000,
      });
      const text = document.querySelector('[aria-label^="About "]')?.textContent ?? '';
      unmount();
      cleanup();
      return text;
    };

    expect(await open('yichun2')).toContain('Consultant · @yichun2');
    const plain = await open('ming');
    expect(plain).toContain('Consultant');
    expect(plain).not.toContain('@');
  });
});
