/**
 * 從拼圖盒拖出來的那張小卡:放在按鈕上的哪裡、指標抓在小卡的哪一點。
 *
 * 小卡「坐」在按鈕上的位置 = 左緣在按鈕左緣往內 `inset`、垂直置中 —— 飛回拼圖盒時也落在這裡,
 * 所以拿起來(從這裡出發)跟放回去(回到這裡)是同一個位置。
 * 抓點照按下去的位置算,不寫死:寫死的話不管按在按鈕哪裡,小卡都把指標放在同一點,按在右半邊時一拿起來就往左跳。
 */

type Pt = {x: number; y: number};
type ButtonRect = {left: number; top: number; height: number};
type CardSize = {w: number; h: number};

/** 小卡在按鈕上的左上角(螢幕座標) */
export function cardRest(button: ButtonRect, card: CardSize, inset: number): {left: number; top: number} {
  return {left: button.left + inset, top: button.top + (button.height - card.h) / 2};
}

/**
 * 指標離小卡左上角多遠:從按下去那一點、小卡在按鈕上的位置算,夾在小卡範圍內 ——
 * 按鈕比小卡寬(整欄寬),按在名稱右邊的空白處時,小卡的右緣停在指標下,不會拿到一張離手很遠的卡
 */
export function ghostGrab(press: Pt, button: ButtonRect, card: CardSize, inset: number): Pt {
  const rest = cardRest(button, card, inset);
  const clamp = (v: number, hi: number) => Math.min(Math.max(0, hi), Math.max(0, v));
  return {x: clamp(press.x - rest.left, card.w), y: clamp(press.y - rest.top, card.h)};
}
