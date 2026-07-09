// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'scripts/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: ['src/parser/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'JSON.parse is forbidden on the report path (ENGINE-05).',
        },
        {
          selector: "CallExpression[callee.property.name='toArray']",
          message:
            'Readable.toArray() buffers the entire stream — forbidden on the report path.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'fs',
          property: 'readFileSync',
          message: 'Use the streaming parser pipeline instead.',
        },
        {
          object: 'fs',
          property: 'readFile',
          message: 'Use the streaming parser pipeline instead.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              importNames: ['readFile', 'readFileSync'],
              message:
                'Use fs.createReadStream via the stream-json pipeline instead.',
            },
            {
              name: 'fs',
              importNames: ['readFile', 'readFileSync'],
              message:
                'Use fs.createReadStream via the stream-json pipeline instead.',
            },
          ],
        },
      ],
    },
  },
);
