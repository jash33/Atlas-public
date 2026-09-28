import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

const css = readFileSync(new URL('../shell.css', import.meta.url), 'utf8');
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0]!;

describe('notification layout', () => {
  it('anchors a compact toast to the bottom right of the viewport', () => {
    const toast = rule('.live-mismatch-alert');
    expect(toast).toContain('position: fixed');
    expect(toast).toContain('bottom:');
    expect(toast).not.toContain('top:');
    expect(toast).toContain('width: min(400px, calc(100vw - 32px))');
  });

  it('centers the badge without asymmetric vertical padding', () => {
    const badge = rule('.notification-badge');
    expect(badge).toContain('align-items: center');
    expect(badge).toContain('justify-content: center');
    expect(badge).toContain('padding: 0 4px;');
    expect(badge).toContain('box-sizing: border-box');
  });

  it('spaces the visible toast content despite the preceding screen-reader announcement', () => {
    expect(css.includes('.live-mismatch-alert > div:not(.live-mismatch-alert-actions)')).toBe(true);
  });
});
