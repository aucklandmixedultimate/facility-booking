import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx,mjs}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { react },
    rules: {
      // Counts <Component/> as a use, so unused components are reported like any variable.
      'react/jsx-uses-vars': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
    },
  },
  {
    // The booking site's modules share helpers and components with each other (split from one
    // file); they hot-reload as whole modules in dev, which is fine.
    files: ['src/booking/**/*.jsx', 'src/booking-system.jsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Build/deploy tooling runs under Node, not the browser.
    files: ['scripts/**/*.{js,mjs}', 'tests/**/*.mjs', '*.config.js'],
    languageOptions: { globals: globals.node },
  },
])
