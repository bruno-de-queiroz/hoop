import { defineConfig } from 'vitest/config';

// Run all:             npx vitest run
// Run unit only:       npx vitest run --project unit
// Run integration only: npx vitest run --project integration

const sharedAlias = {
  // node-datachannel is a native WebRTC addon that requires a compiled binary.
  // Our tests only exercise TCP transport, so we stub this out.
  'node-datachannel/polyfill': new URL('./src/__mocks__/node-datachannel-polyfill.ts', import.meta.url).pathname,
  'node-datachannel': new URL('./src/__mocks__/node-datachannel.ts', import.meta.url).pathname,
};

const sharedDeps = {
  // Force vite to process node-datachannel so that resolve.alias intercepts it.
  inline: ['node-datachannel', '@libp2p/webrtc'] as string[],
};

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    environment: 'node',
    server: {
      deps: sharedDeps,
    },
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.e2e.test.ts'],
          server: { deps: sharedDeps },
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.e2e.test.ts'],
          server: { deps: sharedDeps },
        },
      },
    ],
  },
});
