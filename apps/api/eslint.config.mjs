import base from '@ops/config/eslint/base.mjs';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Nest resolves dependencies from constructor parameter types at runtime, so
        // classes used only as injected types must stay as value imports. These two
        // flags tell `consistent-type-imports` not to rewrite them to `import type`.
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    },
  },
  {
    // Platform modules are reusable across products: they must not know the Operations domain.
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/operations/**', '**/operations'],
              message: 'Platform modules must not import from src/operations.',
            },
          ],
        },
      ],
    },
  },
];
