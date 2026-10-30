import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  fixedExtension: false,
  target: 'node22',
  platform: 'node',
  clean: true,
  dts: true,
});
