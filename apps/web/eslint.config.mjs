import base from '@ops/config/eslint/base.mjs';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * The base config already registers the `@typescript-eslint` plugin for every
 * file. ESLint refuses to load a second copy of a plugin under the same name,
 * so the copy bundled with eslint-config-next is dropped and the base one is
 * used for Next's TypeScript rules too.
 */
function withoutTypescriptPlugin(configs) {
  return configs.map((config) => {
    if (!config.plugins || !('@typescript-eslint' in config.plugins)) {
      return config;
    }
    const plugins = { ...config.plugins };
    delete plugins['@typescript-eslint'];
    return { ...config, plugins };
  });
}

// Next.js already adds browser and Node.js globals for every source file.
const config = [
  ...base,
  ...withoutTypescriptPlugin(nextCoreWebVitals),
  ...withoutTypescriptPlugin(nextTypescript),
  {
    // eslint-config-next relaxes this rule to a warning; keep the stricter
    // monorepo-wide setting from the base config.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unused-expressions': 'error',
    },
  },
];

export default config;
