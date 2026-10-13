/** @type {import('jest').Config} */
const config = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // The generated Prisma client imports its own files as "./x.js" (they are .ts on disk).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  coverageDirectory: './coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/**/*.spec.ts'],
};

export default config;
