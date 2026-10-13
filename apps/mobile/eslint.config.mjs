import base from '@ops/config/eslint/base.mjs';
import expo from 'eslint-config-expo/flat.js';

export default [
  ...expo,
  ...base,
  {
    settings: {
      // eslint-config-expo asks eslint-plugin-react to "detect" the React version, which
      // calls an API that ESLint 10 removed. Stating the version skips the detection.
      react: { version: '19.2' },
    },
  },
];
