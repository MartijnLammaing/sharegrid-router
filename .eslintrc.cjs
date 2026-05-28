/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // Only console.error is permitted in config.ts (before pino is initialised).
    // startup-banner.ts is also exempt — it prints the startup URL to stdout
    // as a deliberate operator-facing message, not a log event.
    'no-console': ['error', { allow: ['error'] }],
  },
  overrides: [
    {
      files: ['src/startup-banner.ts'],
      rules: {
        // The startup banner writes directly to stdout — this is intentional
        // operator-facing output, not application logging.
        'no-console': ['error', { allow: ['error', 'log'] }],
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
};
