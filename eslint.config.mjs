import { createRequire } from 'node:module'

const require = createRequire(new URL('./scripts/package.json', import.meta.url))
const js = require('@eslint/js')
const stylistic = require('@stylistic/eslint-plugin')
const globals = require('globals')

const files = ['scripts/**/*.js', 'extensions/**/*.js']

export default [
  { files, ...js.configs.recommended },
  { files, ...stylistic.configs.recommended },
  {
    files,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'curly': ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
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
