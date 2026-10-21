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
    rules: js.configs.recommended.rules,
  },
]
