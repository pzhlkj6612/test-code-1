import { createRequire } from 'node:module'

const require = createRequire(new URL('./scripts/package.json', import.meta.url))
const js = require('@eslint/js')
const globals = require('globals')

export default [
  {
    files: ['scripts/**/*.js', 'extensions/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // Match TypeScript's ts(6133) "declared but its value is never read".
      'no-unused-vars': ['error', {
        vars: 'all',
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: false,
      }],
    },
  },
]
