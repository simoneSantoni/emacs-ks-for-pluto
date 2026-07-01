// Shared config for Mozilla's `web-ext` tool (lint / build / run).
// Keeps development-only files out of the linted/packaged add-on.
export default {
  ignoreFiles: [
    'store/**',
    '*.zip',
    '*.xpi',
    'web-ext-artifacts/**',
    'web-ext-config.mjs',
    'CLAUDE.md',
    'README.md',
    'icons/icon.svg',
  ],
};
