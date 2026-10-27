/**
 * 把一組對話分享給同事。
 *
 * 版面照 **@ 按鈕那顆選人浮層**的樣子,左邊多一格勾選:搜尋框 + 一列一個人(名字 + 職稱/帳號的副行),
 * 左邊是設計系統的 CheckboxInput,不是可選取 Table。搜尋規則也跟 @ 選單
 * 同一條(`filterPeople`)。
 *
 * 勾選框只負責**加人**;移除已分享的人是每一列自己的那顆鈕(見底下的
 * `handleRemove`)。兩件事分開,是因為它們的後果不對稱。
 */
import {useEffect, useMemo, useState} from 'react';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack, Layout, LayoutContent, LayoutFooter, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Search} from 'lucide-react';

import {LoadingScreen} from './LoadingScreen';
import {shareConversation, unshareConversation} from '../lib/conversationsApi';
import {
  mentionablePeople,
  peopleDirectoryFailed,
  peopleDirectoryLoaded,
  usePeopleDirectory,
} from '../lib/peopleDirectory';
import {toastError, toastInfo} from '../lib/toast';
import {filterPeople, personName} from '../lib/people';
import {useDialogExit} from './useDialogExit';
import {usePinnedDialogTop} from './usePinnedDialogTop';

type Props = {
  conversationId: string;
  conversationTitle: string;
  /** 已經分享出去的人,清單裡要標出來 */
  alreadyShared: string[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onShared: () => void;
};

export function ShareDialog({
  conversationId,
  conversationTitle,
  alreadyShared,
  isOpen,
  onOpenChange,
  onShared,
}: Props) {
  // 退場(淡出 + 縮一點點)要演得完,`close()` 就得延後 —— 全站共用同一支
  const exit = useDialogExit(onOpenChange);
  /*
   * 名單走**全站共用的那一份**(`lib/peopleDirectory`),這一頁不自己抓
   * (**全站只有一份名冊**)。
   *
   * 自己抓一份 `listShareableUsers()` 的話:每次打開都多打一支請求
   * (名冊早就載好了),而且頭像/職稱跟 @ 選單、共用名單不保證是同一份資料。
   */
  usePeopleDirectory();
  // 「還在抓」要跟「抓完了但沒有人」分開 —— 前者是風(載入中),後者講「沒有人可以分享」
  const people = peopleDirectoryLoaded() ? mentionablePeople() : null;
  /** 「同事清單撈不到」——只跟名單有關,不要拿它去報分享失敗 */
  const failed = peopleDirectoryFailed();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isSending, setIsSending] = useState(false);
  /** 正在移除誰。同時只准一個 —— 兩顆一起按的話 `alreadyShared` 會重整兩次 */
  const [removing, setRemoving] = useState<string | null>(null);
  /*
   * 這次打開已經移除掉的人。
   *
   * ⚠️ 需要它是因為 `alreadyShared` 是**呼叫端傳進來的一份快照**:移除成功後
   * `onShared()` 會叫上層重抓,但那個 prop 不會跟著變 —— 少了這一份,被移除的
   * 人會繼續掛著「· shared」與那顆移除鈕,看起來像沒成功。
   */
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // 關掉時把狀態清乾淨,下次打開不會殘留上次的勾選
  useEffect(() => {
    if (isOpen) return;
    setQuery('');
    setSelected(new Set());
    setRemoving(null);
    setRemoved(new Set());
  }, [isOpen]);

  const shown = useMemo(() => filterPeople(people ?? [], query), [people, query]);

  /*
   * 上緣釘住、只讓下緣伸縮:打字把名單篩短時,置中的對話框會上下
   * 一起收,正在打字的搜尋框每打一個字往下跳一次。理由與作法見 `usePinnedDialogTop`。
   * ⚠️ 名冊還在載入時先不釘:釘的會是 Loading 那一小塊的中心,名單一到就整個撞地板。
   */
  const pin = usePinnedDialogTop(isOpen && people !== null);

  const toggle = (username: string, next: boolean) => {
    setSelected((set) => {
      const copy = new Set(set);
      if (next) copy.add(username);
      else copy.delete(username);
      return copy;
    });
  };

  async function handleShare() {
    const usernames = [...selected];
    if (usernames.length === 0) return;
    setIsSending(true);
    try {
      await shareConversation(conversationId, usernames);
      toastInfo(
        usernames.length === 1
          ? `Shared with ${usernames[0]}.`
          : `Shared with ${usernames.length} colleagues.`,
      );
      onShared();
      exit.requestClose();
    } catch {
      // 分享失敗跟「清單撈不到」是兩件事,不能共用那條 Banner。
      // 對話框留著不關,他可以直接再按一次。
      toastError('Could not share this chat. Nobody was added.');
    } finally {
      setIsSending(false);
    }
  }

  async function handleRemove(username: string) {
    setRemoving(username);
    try {
      await unshareConversation(conversationId, username);
      setRemoved((set) => new Set(set).add(username));
      // 勾選也一起清掉:留著的話按下 Share 又會馬上把他加回來。
      setSelected((set) => {
        const copy = new Set(set);
        copy.delete(username);
        return copy;
      });
      toastInfo(`Removed ${username}.`);
      // 對話框不關 —— 移除常常是連著做好幾個。`onShared` 只是「名單變了,
      // 重新抓一次」的訊號,加人跟移除共用它。
      onShared();
    } catch {
      toastError(`Could not remove ${username}. Nothing changed.`);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Dialog
      isOpen={isOpen}
      {...exit.dialogProps}
      width={420}
      purpose="form"
      ref={pin.ref}
      style={pin.style}
    >
      {/*
        走 `Layout` + `LayoutContent`,跟 `FilesDialog` 同一個形狀:內容直接塞進 `Dialog`
        的話面板內層是 `overflow: hidden`,視窗矮的時候 Cancel / Share 那排會落在 75vh
        之外**捲不到也點不到**。
        標頭與按鈕釘住,只有中間那層捲;整個框的高度上限由 `Dialog` 管,名單自己不設 maxHeight。
      */}
      <Layout
        header={
          <DialogHeader
            title="Share this chat"
            subtitle={conversationTitle}
            onOpenChange={exit.dialogProps.onOpenChange}
          />
        }
        content={
          /*
           * ⚠️ `data-thin-scrollbar` 要跟著搬過來 —— `global.css` 那條規則的註解
           * 點名的呼叫端就是「@ 選人浮層、**分享名單**」,兩邊的捲軸風格要一致。
           * 捲的那一層是 `LayoutContent`,記號不掛在這裡的話就只剩瀏覽器預設捲軸。
           */
          <LayoutContent {...{'data-thin-scrollbar': ''}}>
            <VStack gap={3}>
              {failed ? (
                <Banner
                  status="warning"
                  title="Could not load the list of colleagues."
                  description="Check the connection and try again — this is not the same as having nobody to share with."
                />
              ) : null}

              <TextInput
                label="Search colleagues"
                isLabelHidden
                placeholder="Search colleagues"
                value={query}
                // ⚠️ 原樣進 state:注音的還原在 `filterPeople` 裡做,
                // 在這裡改寫會把輸入法的組字打斷
                onChange={setQuery}
                startIcon={Search}
                hasClear
              />

              {people === null ? (
                <LoadingScreen isCompact label="Loading colleagues" />
              ) : shown.length === 0 ? (
                <Text type="supporting" color="secondary">
                  {query ? 'No colleague matches that.' : 'No colleagues available to share with.'}
                </Text>
              ) : (
                <VStack gap={1}>
                  {/*
                    全選 / 全部取消。對象是**搜尋過濾後**看得到的
                    這一批 —— 搜一個職稱再全選,勾的就是那批;半勾 = indeterminate。
                  */}
                  <CheckboxInput
                    label={`Select all (${shown.length})`}
                    size="sm"
                    value={
                      shown.length > 0 && shown.every((p) => selected.has(p.username))
                        ? true
                        : shown.some((p) => selected.has(p.username))
                          ? 'indeterminate'
                          : false
                    }
                    onChange={(checked) => {
                      setSelected((set) => {
                        const copy = new Set(set);
                        for (const p of shown) {
                          if (checked) copy.add(p.username);
                          else copy.delete(p.username);
                        }
                        return copy;
                      });
                    }}
                    width="100%"
                  />
                  {shown.map((p) => {
                    const isShared =
                      alreadyShared.includes(p.username) && !removed.has(p.username);
                    return (
                      /*
                       * 一列 = 一顆 CheckboxInput:label 是名字、description 是
                       * 職稱與帳號 —— 點名字就能勾,焦點與報讀都是元件自己的,
                       * 不必再疊一層可點的列(疊了就是兩個互動元素搶同一下點擊)。
                       *
                       * 已經分享出去的人右邊多一顆「移除」。**勾選框只負責加人** ——
                       * 讓「取消勾選」等於取消分享的話,滑一下手就把人踢掉了,而且
                       * 送出前完全看不出這一次會移除誰。
                       */
                      <HStack key={p.username} gap={2} vAlign="center">
                        <CheckboxInput
                          size="sm"
                          label={personName(p.display_name || p.username)}
                          description={[
                            p.role,
                            // 帳號照原樣印(登入用的),已分享的標出來
                            isShared ? `${p.username} · shared` : p.username,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          value={selected.has(p.username)}
                          onChange={(checked) => toggle(p.username, checked)}
                          width="100%"
                        />
                        {isShared ? (
                          /*
                           * 直接移除,不再跳一次確認 —— 跟側邊欄的「刪除對話 /
                           * 離開共用」同一個規格。按錯的代價是再勾一次加回來,
                           * 而多一層確認會讓每次正常的移除都多一步。
                           */
                          <Button
                            label="Remove"
                            variant="ghost"
                            size="sm"
                            isLoading={removing === p.username}
                            isDisabled={removing !== null}
                            onClick={() => void handleRemove(p.username)}
                          />
                        ) : null}
                      </HStack>
                    );
                  })}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          // 包 LayoutFooter 給底列內距:裸放 HStack 時按鈕貼在對話框右下緣(跟改密碼 / MFA 對話框同一個做法)
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={exit.requestClose} />
              <Button
                label={selected.size > 0 ? `Share with ${selected.size}` : 'Share'}
                variant="primary"
                isDisabled={selected.size === 0}
                isLoading={isSending}
                onClick={() => void handleShare()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
