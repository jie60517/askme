/**
 * 檔案區的分組翻譯:後端「依檔名」→ 畫面「依第幾個對話」,
 * 以及餵給燈箱那條 strip 的索引一致性。
 */
import {describe, expect, it} from 'vitest';

import type {ConversationFileGroup, ConversationFileVersion} from '../chatApi';
import {buildFileView, countFiles, stripIndexOf} from '../conversationFiles';

function version(over: Partial<ConversationFileVersion>): ConversationFileVersion {
  return {
    kind: 'output',
    session_id: 's-1',
    size: 100,
    created_at: '2026-08-21T01:00:00Z',
    qa_id: 1,
    note_id: null,
    turn: 1,
    question: 'Q',
    asked_by: 'Alice',
    version: 1,
    missing: false,
    ...over,
  } as ConversationFileVersion;
}

/** 兩題 + 一則便條:report.md 有兩版(第 3 題是新版),zip 看不了,便條夾一張圖。 */
function fixtures(): ConversationFileGroup[] {
  return [
    {
      name: 'report.md',
      versions: [
        version({session_id: 's-3', qa_id: 3, turn: 3, version: 2, question: '改一下報告'}),
        version({session_id: 's-1', qa_id: 1, turn: 1, version: 1, question: '寫一份報告'}),
      ],
    },
    {
      name: 'bundle.zip',
      versions: [version({session_id: 's-1', qa_id: 1, turn: 1, question: '寫一份報告'})],
    },
    {
      name: 'shot.png',
      versions: [
        version({
          kind: 'upload',
          session_id: 'n-9',
          qa_id: null,
          note_id: 9,
          turn: 1,
          question: '@ming 看一下',
          asked_by: '小明',
        }),
      ],
    },
  ];
}

describe('buildFileView', () => {
  it('依「第幾個對話」分組,新的在上面;便條排在它錨定那一題的上面', () => {
    const {list} = buildFileView(fixtures());
    expect(list.map((g) => g.key)).toEqual(['turn-3', 'note-9', 'turn-1']);
  });

  it('版次:兩版的檔案,舊版標出新版在第幾題;單版的不標', () => {
    const {list} = buildFileView(fixtures());
    const old = list.find((g) => g.key === 'turn-1')!.rows.find((r) => r.name === 'report.md')!;
    expect(old.isCurrent).toBe(false);
    expect(old.newerTurn).toBe(3);
    expect(old.totalVersions).toBe(2);
    const zip = list.find((g) => g.key === 'turn-1')!.rows.find((r) => r.name === 'bundle.zip')!;
    expect(zip.totalVersions).toBe(1);
    expect(zip.newerTurn).toBeNull();
  });

  it('strip 只收看得了的(zip 不進去),索引照畫面順序', () => {
    const view = buildFileView(fixtures());
    const names = view.strip.map((i) => i.name);
    expect(names).not.toContain('bundle.zip');
    // 畫面順序:turn-3 的 report.md → note-9 的 shot.png → turn-1 的 report.md
    expect(names).toEqual(['report.md', 'shot.png', 'report.md']);
    // 每一列記的 stripIndex 要跟 strip 對得上
    for (const group of view.list) {
      for (const row of group.rows) {
        if (row.stripIndex !== null) {
          expect(view.strip[row.stripIndex].previewUrl).toBe(row.item.previewUrl);
        }
      }
    }
  });

  it('missing 的檔案不進 strip(切到它只會是一片抓不到的空白)', () => {
    const groups = fixtures();
    groups[0].versions[0].missing = true;
    const {list, strip} = buildFileView(groups);
    const missingRow = list.find((g) => g.key === 'turn-3')!.rows[0];
    expect(missingRow.stripIndex).toBeNull();
    expect(strip.map((i) => i.name)).toEqual(['shot.png', 'report.md']);
  });
});

describe('stripIndexOf', () => {
  it('比對的是 kind+session+檔名組出來的 previewUrl,不是檔名(同名檔很常見)', () => {
    const {strip} = buildFileView(fixtures());
    expect(stripIndexOf(strip, 'output', 's-3', 'report.md')).toBe(0);
    expect(stripIndexOf(strip, 'output', 's-1', 'report.md')).toBe(2);
    expect(stripIndexOf(strip, 'upload', 'n-9', 'shot.png')).toBe(1);
  });

  it('找不到回 -1(呼叫端要留「照舊下載」那條路)', () => {
    const {strip} = buildFileView(fixtures());
    expect(stripIndexOf(strip, 'output', 's-1', 'bundle.zip')).toBe(-1);
  });
});

describe('countFiles', () => {
  it('算的是版本數的總和(檔案區按鈕上的數字)', () => {
    expect(countFiles(fixtures())).toBe(4);
  });
});
