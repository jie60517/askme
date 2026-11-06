/**
 * Settings → Keyboard shortcuts。
 *
 * 照官網 Astryx 0.7.8 `settings-dialog` 範本的 `ShortcutsPanel` / `ShortcutRow`:
 * 鍵帽按下去變成錄鍵框、按下新的組合就換掉,Esc 或點開取消;每一列一個開關可以停用;改過的旁邊多一顆還原。
 * 跟範本不一樣的地方:
 * - **沒有 tooltip、錄鍵框沒有 placeholder**:畫面不放教人怎麼用的字。
 * - **沒有「全部恢復預設」**:三個鍵各自有還原,一顆總還原只是多一個鈕。
 * - 存法:範本是元件自己的 state,這裡是 `lib/shortcuts.ts`(本機先套、送帳號,全站的監聽讀同一份)。
 * - **只收帶 Ctrl / ⌘ 或 Alt 的組合**(`recordKey`),不帶的錄鍵框標紅「Needs Ctrl or Alt」——
 *   單鍵收進來,全站的 Enter / Space 會被吃掉。
 * - **會撞的不收**,錄鍵框標紅「Already in use」:兩個快捷鍵被同一下觸發的話,只有先掛的那個按得出來。
 *   打開開關、按還原時要回到的預設鍵如果撞到別人,也不直接套,改成進錄鍵框、標同一個紅字,讓人另外挑一組。
 */
import {useState} from 'react';

import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Kbd} from '@astryxdesign/core/Kbd';
import {HStack} from '@astryxdesign/core/Layout';
import {Switch} from '@astryxdesign/core/Switch';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Undo2} from 'lucide-react';

import {saveShortcuts} from '../lib/loginApi';
import {
  chordKeys,
  chordLabel,
  collisionWith,
  defaultChord,
  isApplePlatform,
  recordKey,
  resolveShortcut,
  sameChord,
  setShortcutOverrides,
  SHORTCUTS,
  useShortcutOverrides,
  type Chord,
  type ShortcutId,
  type ShortcutOverrides,
} from '../lib/shortcuts';
import {SettingsCard, SettingsRow} from './settingsRows';

/**
 * 錄鍵框的寬(刻意的字面值):放得下 Ctrl ⇧ O 三顆鍵帽與紅字「Needs Ctrl or Alt」,
 * 錄鍵框與鍵帽差不多寬,按下去那一列才不會跳。沒有「元件寬」的 token。範本是 96(它的 ⌘ 比 Ctrl 窄)。
 */
const RECORDER_WIDTH = 132;

/** 錄鍵框底下的紅字:沒問題時沒有 */
type RecorderError = 'in-use' | 'needs-modifier' | null;
const ERROR_TEXT: Record<Exclude<RecorderError, null>, string> = {
  'in-use': 'Already in use',
  'needs-modifier': 'Needs Ctrl or Alt',
};

function ShortcutRecorder({
  label,
  error,
  onKey,
  onCancel,
}: {
  label: string;
  error: RecorderError;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCancel: () => void;
}) {
  return (
    <TextInput
      // 跟同一列的開關(「New chat shortcut」)分開唸:這一格是「替 New chat 錄新的鍵」
      label={`New key for ${label}`}
      isLabelHidden
      size="sm"
      width={RECORDER_WIDTH}
      value=""
      hasAutoFocus
      status={error ? {type: 'error', message: ERROR_TEXT[error]} : undefined}
      onKeyDown={onKey}
      onBlur={onCancel}
    />
  );
}

export function ShortcutSettings() {
  const overrides = useShortcutOverrides();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<RecorderError>(null);
  const isApple = isApplePlatform();

  const save = (next: ShortcutOverrides) => {
    setShortcutOverrides(next);
    void saveShortcuts(next);
  };
  const without = (id: ShortcutId): ShortcutOverrides => {
    const next = {...overrides};
    delete next[id];
    return next;
  };
  const startRecording = (id: ShortcutId, why: RecorderError = null) => {
    setError(why);
    setRecording(id);
  };
  const stopRecording = () => {
    setRecording(null);
    setError(null);
  };

  /** 把 `id` 設成 `chord`;撞到別人就不套,進錄鍵框讓人另外挑 */
  const apply = (id: ShortcutId, chord: Chord) => {
    if (collisionWith(overrides, id, chord)) {
      startRecording(id, 'in-use');
      return false;
    }
    save(sameChord(chord, defaultChord(id)) ? without(id) : {...overrides, [id]: chord});
    return true;
  };

  const onRecorderKey = (id: ShortcutId) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const got = recordKey(e.nativeEvent);
    // Tab 照常讓焦點離開(錄鍵框失焦就取消),其他一律吞掉:不打字進去,也不讓全站快捷鍵在錄的時候觸發
    if (got.kind === 'leave') return;
    e.preventDefault();
    e.stopPropagation();
    if (got.kind === 'cancel') stopRecording();
    else if (got.kind === 'needs-modifier') setError('needs-modifier');
    else if (got.kind === 'chord' && apply(id, got.chord)) stopRecording();
  };

  return (
    <SettingsCard title="Shortcuts">
      {SHORTCUTS.map((def) => {
        const resolved = resolveShortcut(overrides, def.id);
        const isEnabled = resolved !== false;
        const chord = isEnabled ? resolved : def.binding;
        // 停用也是一種「改過」,但它的開關本身就是還原 —— 旁邊再放一顆還原是同一件事兩個鈕(範本的理由)
        const isCustom = overrides[def.id] != null && overrides[def.id] !== false;
        return (
          <SettingsRow
            key={def.id}
            title={def.label}
            icon={def.icon}
            control={
              <HStack gap={2} align="center">
                {isCustom ? (
                  <IconButton
                    label={`Reset ${def.label} to its default`}
                    icon={<Icon icon={Undo2} size="sm" />}
                    variant="ghost"
                    size="sm"
                    onClick={() => apply(def.id, def.binding)}
                  />
                ) : null}
                {recording === def.id ? (
                  <ShortcutRecorder
                    label={def.label}
                    error={error}
                    onKey={onRecorderKey(def.id)}
                    onCancel={stopRecording}
                  />
                ) : (
                  <Button
                    // 鍵帽是看的,`label` 是報讀念的(Astryx:有 children 時 label 變成 aria-label)。
                    // ghost 不是 secondary:Kbd 自己就是灰底鍵帽,外面再一層灰是「卡片裡的卡片」(範本的理由)
                    label={isEnabled ? chordLabel(chord, isApple) : 'No shortcut'}
                    variant="ghost"
                    size="sm"
                    isDisabled={!isEnabled}
                    onClick={() => startRecording(def.id)}
                  >
                    {isEnabled ? <Kbd keys={chordKeys(chord)} /> : undefined}
                  </Button>
                )}
                <Switch
                  size="sm"
                  label={`${def.label} shortcut`}
                  isLabelHidden
                  value={isEnabled}
                  onChange={(on: boolean) => {
                    if (!on) save({...overrides, [def.id]: false});
                    // 打開 = 回到預設那一組(撞到別人就進錄鍵框,開關維持關)
                    else apply(def.id, def.binding);
                  }}
                />
              </HStack>
            }
          />
        );
      })}
    </SettingsCard>
  );
}
