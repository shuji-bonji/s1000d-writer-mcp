import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      'no-console': 'error',
    },
  },
  {
    // logger だけは stderr への console.error を許す（stdout は JSON-RPC の線なので使わない）
    files: ['src/utils/logger.ts'],
    rules: { 'no-console': ['error', { allow: ['error'] }] },
  },
  { ignores: ['dist/**', 'node_modules/**'] },
);
