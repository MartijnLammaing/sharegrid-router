const tseslint = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs['flat/recommended-type-checked'],
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Only console.error is permitted in config.ts (before pino is initialised).
      // startup-banner.ts is also exempt — it prints the startup URL to stdout
      // as a deliberate operator-facing message, not a log event.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['src/startup-banner.ts'],
    rules: {
      // The startup banner writes directly to stdout — intentional operator-facing
      // output, not application logging.
      'no-console': ['error', { allow: ['error', 'log'] }],
    },
  },
];
