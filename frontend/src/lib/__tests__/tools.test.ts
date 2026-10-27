/**
 * 執行過程上的工具名:MCP 工具去掉 `mcp__<server>__` 前綴,內建工具原樣。
 */
import {describe, expect, it} from 'vitest';

import {toolLabel} from '../tools';

describe('toolLabel', () => {
  it('MCP 工具去掉前綴,內建工具原樣', () => {
    expect(toolLabel('mcp__docs__search')).toBe('search');
    expect(toolLabel('mcp__docs__fetch_page')).toBe('fetch_page');
    expect(toolLabel('Read')).toBe('Read');
  });
});
