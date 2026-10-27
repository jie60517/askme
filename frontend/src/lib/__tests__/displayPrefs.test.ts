/**
 * 字級/對比拉桿的「值 ↔ 位置」換算。
 *
 * 這兩支沒有畫面,錯了也不會丟例外 —— 症狀是拉桿的拇指停在錯的地方、
 * 100% 不再置中。
 */
import {describe, expect, it} from 'vitest';

import {
  normalizePrefs,
  pinnedRemTokens,
  SLIDER_MAX,
  SLIDER_MIN,
  SLIDER_POSITION_MAX,
  SLIDER_POSITION_MIN,
  SLIDER_POSITION_STEP,
  sliderPositionToValue,
  valueToSliderPosition,
} from '../displayPrefs';

const MID = 100;
const POSITION_MID = (SLIDER_POSITION_MIN + SLIDER_POSITION_MAX) / 2;

describe('valueToSliderPosition', () => {
  /*
   * ⚠️ 這條是這套換算的目的:100% 必須**精確**落在位置域的中點。
   */
  it('100% 落在拉桿正中央', () => {
    expect(valueToSliderPosition(MID)).toBe(POSITION_MID);
  });

  it('兩端對到兩端', () => {
    expect(valueToSliderPosition(SLIDER_MIN)).toBe(SLIDER_POSITION_MIN);
    expect(valueToSliderPosition(SLIDER_MAX)).toBe(SLIDER_POSITION_MAX);
  });

  it('下半段一格位置 = 1%,上半段 = 2%', () => {
    // 50~100 這 50 個百分點攤在前半段
    expect(valueToSliderPosition(75)).toBe(25);
    // 100~200 這 100 個百分點攤在後半段
    expect(valueToSliderPosition(150)).toBe(75);
  });
});

describe('sliderPositionToValue', () => {
  it('中點換回 100%', () => {
    expect(sliderPositionToValue(POSITION_MID)).toBe(MID);
  });

  it('兩端換回兩端', () => {
    expect(sliderPositionToValue(SLIDER_POSITION_MIN)).toBe(SLIDER_MIN);
    expect(sliderPositionToValue(SLIDER_POSITION_MAX)).toBe(SLIDER_MAX);
  });

  /*
   * ⚠️ 回歸測試:**拉桿停在中點時,換算回來要精確等於 100**。
   *
   * 100% 時要完全沒有 `filter: contrast()` 這條規則
   * (靠 `data-user-contrast` 開關),不是乘以 1 —— 而那個開關判斷的是
   * 「值等不等於 100」。這裡只要算出 99.999…,規則就會被留下來,
   * 有些瀏覽器會為 `contrast(1)` 另開合成層,字會糊。
   */
  it('中點換算不能有浮點誤差', () => {
    expect(Number.isInteger(sliderPositionToValue(POSITION_MID))).toBe(true);
    expect(sliderPositionToValue(POSITION_MID)).not.toBe(99.99999999999999);
  });
});

describe('值 ↔ 位置 的往返', () => {
  it('每一個拉得到的位置都換得回原本那一格', () => {
    for (let p = SLIDER_POSITION_MIN; p <= SLIDER_POSITION_MAX; p += SLIDER_POSITION_STEP) {
      const value = sliderPositionToValue(p);
      expect(value).toBeGreaterThanOrEqual(SLIDER_MIN);
      expect(value).toBeLessThanOrEqual(SLIDER_MAX);
      // 換回去要回到原本那一格(浮點誤差容忍到小數第 9 位)
      expect(valueToSliderPosition(value)).toBeCloseTo(p, 9);
    }
  });

  /*
   * ⚠️ 這條釘的是**刻度有多細**,不是在測 bug。
   *
   * 一格 0.5 個位置,拖起來才滑順(一格 5 個位置的話是下半段 5%、上半段 10%,
   * 105/115…拉不到)。代價是**值不保證是整數**(畫面與 `aria-valuetext` 要自己 round),
   * 而「兩段密度不同」那件事仍然在(那是 100% 置中的數學必然)。
   * 哪天有人「順手」把它調回粗格,這條會亮 —— 先讀 `lib/displayPrefs.ts` 的說明再決定。
   */
  it('一格在下半段是 0.5%、上半段是 1%', () => {
    expect(sliderPositionToValue(0)).toBe(50);
    expect(sliderPositionToValue(SLIDER_POSITION_STEP)).toBeCloseTo(50.5, 9);

    expect(sliderPositionToValue(POSITION_MID)).toBe(100);
    expect(sliderPositionToValue(POSITION_MID + SLIDER_POSITION_STEP)).toBeCloseTo(101, 9);
  });

  /*
   * 既有偏好裡的 105 **拉得到**(105 落在位置 52.5,正好是 0.5 的倍數)。
   * 這條順便釘住「存著的值不會被動到」。
   */
  it('105% 正好落在格線上', () => {
    const position = valueToSliderPosition(105);
    expect(position).toBe(52.5);
    expect(sliderPositionToValue(position)).toBe(105);
    expect(position % SLIDER_POSITION_STEP).toBe(0);
  });
});

describe('normalizePrefs', () => {
  it('正常值照收', () => {
    expect(normalizePrefs({fontScale: 120, contrast: 80})).toEqual({fontScale: 120, contrast: 80});
  });

  it('超出範圍的夾回兩端', () => {
    expect(normalizePrefs({fontScale: 999, contrast: -5})).toEqual({
      fontScale: SLIDER_MAX,
      contrast: SLIDER_MIN,
    });
  });

  /*
   * ⚠️ 回歸測試:**壞值要回預設 100,不是下限 50。**
   *
   * 這裡的夾值要跟 `index.html` 那段 inline script 一致,而那段
   * 讀不出數字時套的是 100。這裡若回 `low`(50),localStorage 被寫壞的人
   * 會看到畫面先用 100% 畫出來、JS 一載入就跳成 50%。兩邊各自看都「合理」,
   * 只有壞值那條路不一致,所以平常完全測不出來。
   */
  it('讀不出數字時回預設,不是下限', () => {
    expect(normalizePrefs({fontScale: Number.NaN}).fontScale).toBe(100);
    expect(normalizePrefs({contrast: Number.NaN}).contrast).toBe(100);
    expect(normalizePrefs({fontScale: Number.POSITIVE_INFINITY}).fontScale).toBe(100);
  });

  it('沒給就是預設', () => {
    expect(normalizePrefs(null)).toEqual({fontScale: 100, contrast: 100});
    expect(normalizePrefs({})).toEqual({fontScale: 100, contrast: 100});
  });
});

/*
 * 「這塊畫面不要跟著字級變」靠的就是這一支(個人設定對話框)。
 * 算錯不會丟例外 —— 症狀是對話框的字級**半跟半不跟**,而那要有人剛好去拉拉桿
 * 才看得到。
 */
describe('pinnedRemTokens', () => {
  /** 假的 `:root`:只有這幾個 token,其餘一律回空字串(等於「這個版本沒有」)。 */
  const fakeRoot = (values: Record<string, string>) => (name: string) => values[name] ?? '';

  it('rem 照根字級換算成 px', () => {
    const out = pinnedRemTokens(16, fakeRoot({'--text-body-size': '0.875rem'}));
    expect(out['--text-body-size']).toBe('14px');
    expect(pinnedRemTokens(32, fakeRoot({'--text-body-size': '0.875rem'}))['--text-body-size']).toBe(
      '28px',
    );
  });

  /*
   * ⚠️ 這條是重點:佈景可以把某個 token 換成 px(`theme-neutral` 就把
   * `--radius-element` 換過)。硬釘下去等於**改到外觀**,而那是專案明令不做的事。
   */
  it('不是 rem 的一律跳過,不要去動佈景的決定', () => {
    const out = pinnedRemTokens(16, fakeRoot({'--radius-element': '9999px'}));
    expect(out['--radius-element']).toBeUndefined();
  });

  it('這個版本沒有的 token 也跳過,不會冒出一個 NaNpx', () => {
    const out = pinnedRemTokens(16, fakeRoot({}));
    expect(Object.keys(out)).toHaveLength(0);
  });

  /*
   * ⚠️ 語意那層(`--text-*-size`)才是元件真正讀的。只釘原始階的 `--font-size-*`
   * 是沒有用的 —— 對話框的 `--font-size-base` 確實會變,
   * 畫面上的字照樣跟著放大。
   */
  it('語意階與原始階都要在名單裡', () => {
    const out = pinnedRemTokens(
      16,
      fakeRoot({'--font-size-base': '0.875rem', '--text-label-size': '0.875rem'}),
    );
    expect(Object.keys(out).sort()).toEqual(['--font-size-base', '--text-label-size']);
  });
});
