import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {playwrightLauncher} from '@web/test-runner-playwright';

// Playwright insists on the exact browser build it was pinned against. A CI
// image that ships its own Chromium and points `PLAYWRIGHT_BROWSERS_PATH` at it
// will rarely match that pin, and re-downloading a browser to run a test suite
// is a poor trade. Where such a browser exists, use it; otherwise let
// playwright resolve its own, which is what a developer machine wants.
function installedChromium() {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return explicit;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium-')) continue;
    const binary = join(root, entry, 'chrome-linux', 'chrome');
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

const executablePath = installedChromium();

// Tests run against a real browser rather than a DOM emulation, because cerp is
// built entirely out of one specific piece of browser machinery — the custom
// element registry — and almost nothing it does means anything away from it.
// Whether a definition may be replaced, when the browser snapshots
// `observedAttributes` and `formAssociated`, whether `attributeChangedCallback`
// fires synchronously and with how many arguments, what order the reaction queue
// drains a move in, and whether `connectedMoveCallback` exists at all are the
// behaviours under test. An emulator supplies its own answers to those, so a
// test passing against one says nothing about a browser.
export default {
  files: ['*.test.js'],
  nodeResolve: true,
  browsers: [
    playwrightLauncher({
      product: 'chromium',
      launchOptions: executablePath ? {executablePath} : undefined,
    }),
  ],
  coverageConfig: {
    include: ['index.js'],
    exclude: ['**/node_modules/**'],
    reporters: ['text', 'lcov'],
  },
  testFramework: {
    config: {timeout: '5000'},
  },
};
