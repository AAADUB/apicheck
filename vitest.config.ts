import {defineConfig} from 'vitest/config';
import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-pool-workers';
import {randomBytes} from 'node:crypto';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: {configPath: './wrangler.jsonc'},
    miniflare: {bindings: {TEST_MIGRATIONS: await readD1Migrations('./migrations'), KEK_1: randomBytes(32).toString('base64'), SETUP_TOKEN: 'setup-token-for-tests-0123456789abc', DEV_TOOLS: '1', APP_URL: 'https://check.example', MAIL_FROM: ''}}
  }))],
  test: {include: ['worker/test/**/*.test.ts'], setupFiles: ['./worker/test/setup.ts'], testTimeout: 30000}
});
