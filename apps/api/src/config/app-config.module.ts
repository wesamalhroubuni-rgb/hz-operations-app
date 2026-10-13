import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env';

/**
 * Makes the validated, typed environment available everywhere through
 * `ConfigService<Env, true>`. The `.env` file itself is loaded by dotenv-cli
 * in the package scripts, so this module only reads `process.env`.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
