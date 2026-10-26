import stylistic from '@stylistic/eslint-plugin';
// eslint-disable-next-line import/no-unresolved -- the package has only an exports map, which this resolver cannot read.
import { configs as airbnb } from 'eslint-config-airbnb-extended/legacy';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
// eslint-disable-next-line import/no-unresolved -- the package has only an exports map, which this resolver cannot read.
import tseslint from 'typescript-eslint';

// The project follows Airbnb's style guide with these deliberate exceptions
// (see CONTRIBUTING.md). Prettier owns layout, so eslint-config-prettier comes last.
const exceptions = {
  // for...of, including `for await` over streams, is fine on every runtime this
  // project supports. for...in, labels and `with` stay banned as in Airbnb.
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ForInStatement',
      message: 'for...in also walks the prototype chain; use Object.keys/entries instead.',
    },
    { selector: 'LabeledStatement', message: 'Labels make control flow hard to follow.' },
    { selector: 'WithStatement', message: '`with` is not allowed in strict mode.' },
  ],
  // Retries and in-order writes are sequential on purpose.
  'no-await-in-loop': 'off',
  // Download records and their segments are updated in place by design.
  'no-param-reassign': [
    'error',
    {
      props: true,
      ignorePropertyModificationsFor: [
        // Airbnb's own list (setting this option replaces it, so it is repeated here).
        'acc',
        'accumulator',
        'e',
        'ctx',
        'context',
        'req',
        'request',
        'res',
        'response',
        '$scope',
        'staticContext',
        // This project's download records.
        'download',
        'segment',
        'capture',
        'event',
      ],
    },
  ],
  // Calling a function declared further down the file is ordinary hoisting.
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  // Node ES modules need explicit file extensions.
  'import/extensions': ['error', 'always', { ignorePackages: true }],
  'import/no-extraneous-dependencies': [
    'error',
    {
      devDependencies: [
        '**/*.test.{js,cjs,mjs}',
        'tests/**',
        'scripts/**',
        'eslint.config.mjs',
        // Electron is a build-time dependency; electron-builder ships its runtime.
        'desktop/**',
      ],
    },
  ],
};

// Scripts the extension's pages load before their own code.
const extensionShared = {
  youtubeMedia: 'readonly',
  mediaChoices: 'readonly',
  parseHlsMaster: 'readonly',
};

export default [
  {
    ignores: [
      'dist/',
      'release/',
      'release-*/',
      'node_modules/',
      'vendor/',
      '.yarn/',
      'coverage/',
      'test-results/',
    ],
  },
  // The legacy set is eslint-config-airbnb-base's rules as flat config, for ESLint 9.
  ...airbnb.base.recommended,
  {
    // The legacy set targets ES2018 through parserOptions, which would override this.
    languageOptions: { ecmaVersion: 2024, parserOptions: { ecmaVersion: 2024 } },
    rules: exceptions,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    files: ['extension/**/*.js', 'renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...extensionShared },
    },
  },
  {
    // Airbnb's `strict: never` assumes ES modules, which are always strict. These are
    // classic scripts, so their existing 'use strict' directives stay as they are.
    files: ['extension/**/*.js', 'renderer/**/*.js'],
    rules: { strict: 'off' },
  },
  {
    files: ['extension/background.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Shared scripts also export themselves for the Node tests when `module` exists.
    files: ['extension/hls.js', 'extension/media-choices.js', 'extension/youtube-media.js'],
    languageOptions: { globals: { module: 'readonly' } },
  },
  {
    files: ['core/**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // TypeScript checks names, imports and unused code itself, with type awareness.
      'no-undef': 'off',
      'import/no-unresolved': 'off',
      'no-unused-vars': 'off',
      // Same options as Airbnb's no-unused-vars.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { vars: 'all', args: 'after-used', ignoreRestSiblings: true },
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: true, variables: true, typedefs: false },
      ],
    },
  },
  prettier,
  // Prettier disables Airbnb's `curly: multi-line` because wrapping can break it;
  // always requiring braces keeps the intent and works with Prettier.
  { rules: { curly: ['error', 'all'] } },
  // Two parts of the Airbnb guide that its shared rules do not enforce:
  // descriptive names instead of single letters (23.1), and a blank line after blocks
  // (19.8), extended to separate every function and multi-line statement.
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      'id-length': ['error', { min: 2, properties: 'never', exceptions: ['_'] }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'directive', next: '*' },
        {
          blankLine: 'always',
          prev: '*',
          next: [
            'function',
            'class',
            'multiline-block-like',
            'multiline-const',
            'multiline-expression',
          ],
        },
        {
          blankLine: 'always',
          prev: [
            'function',
            'class',
            'multiline-block-like',
            'multiline-const',
            'multiline-expression',
          ],
          next: '*',
        },
      ],
    },
  },
];
