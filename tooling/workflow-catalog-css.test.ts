import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const shellCss = readFileSync(resolve('apps/console/src/shell.css'), 'utf8');

describe('workflow catalog responsive styles', () => {
  it('keeps the catalog table horizontally reachable on narrow screens', () => {
    expect(shellCss).toContain('.wfc-table-scroll {\n  overflow-x: auto;');
    expect(shellCss).toContain('@media (max-width: 700px)');
    expect(shellCss).toContain(
      '.wfc-controls {\n    align-items: stretch;\n    flex-direction: column;',
    );
  });

  it('keeps the detail grids and history usable on narrow screens', () => {
    expect(shellCss).toContain('.wfd-version-list');
    expect(shellCss).toContain('@media (max-width: 700px)');
    expect(shellCss).toContain('.wfd-overview-grid');
  });
});
