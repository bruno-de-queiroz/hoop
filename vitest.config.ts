import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // node-datachannel is a native WebRTC addon that requires a compiled binary.
      // Our tests only exercise TCP transport, so we stub this out.
      'node-datachannel/polyfill': new URL('./src/__mocks__/node-datachannel-polyfill.ts', import.meta.url).pathname,
      'node-datachannel': new URL('./src/__mocks__/node-datachannel.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        // Force vite to process node-datachannel so that resolve.alias intercepts it.
        inline: ['node-datachannel', '@libp2p/webrtc'],
      },
    },
  },
});
