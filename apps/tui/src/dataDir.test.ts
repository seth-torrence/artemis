import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';

import { APP_NAME, appDataDir, artemisDataDir } from './dataDir.js';

const home = sep === '\\' ? 'C:\\Users\\ada' : '/home/ada';

describe('artemisDataDir', () => {
  it('uses XDG_CONFIG_HOME on Linux when set', () => {
    expect(artemisDataDir({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(
      join('/xdg', APP_NAME),
    );
  });

  it('falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset or empty', () => {
    expect(artemisDataDir({ platform: 'linux', home, env: {} })).toBe(join(home, '.config', APP_NAME));
    expect(artemisDataDir({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '' } })).toBe(
      join(home, '.config', APP_NAME),
    );
  });

  it('uses Application Support on macOS, ignoring XDG', () => {
    expect(artemisDataDir({ platform: 'darwin', home, env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(
      join(home, 'Library', 'Application Support', APP_NAME),
    );
  });

  it('uses %APPDATA% on Windows, with the roaming path as the fallback', () => {
    expect(artemisDataDir({ platform: 'win32', home, env: { APPDATA: 'D:\\Roaming' } })).toBe(
      join('D:\\Roaming', APP_NAME),
    );
    expect(artemisDataDir({ platform: 'win32', home, env: {} })).toBe(
      join(home, 'AppData', 'Roaming', APP_NAME),
    );
  });

  it('lets ARTEMIS_DATA_DIR override everything, resolved to an absolute path', () => {
    const dir = artemisDataDir({ platform: 'linux', home, env: { ARTEMIS_DATA_DIR: 'relative/dir' } });
    expect(dir).toBe(join(process.cwd(), 'relative', 'dir'));
    expect(artemisDataDir({ platform: 'darwin', home, env: { ARTEMIS_DATA_DIR: '' } })).toBe(
      join(home, 'Library', 'Application Support', APP_NAME),
    );
  });

  it('exposes the platform parent on its own', () => {
    expect(appDataDir({ platform: 'linux', home, env: {} })).toBe(join(home, '.config'));
  });
});
