import { Module } from '@nestjs/common';
import { AiKeyVault } from './ai-key-vault';
import { AiKeysController } from './ai-keys.controller';
import { AiKeysService } from './ai-keys.service';

/** The encryption of organizations' AI keys, shared by the routes and the key resolver. */
@Module({
  providers: [AiKeyVault],
  exports: [AiKeyVault],
})
export class AiKeyVaultModule {}

/**
 * `GET /ai/keys`, `PUT` and `DELETE /ai/keys/:provider` (ADR-0012). Access and the change
 * recorder are global; the key checker and the provider selector come from the global AI module.
 */
@Module({
  imports: [AiKeyVaultModule],
  controllers: [AiKeysController],
  providers: [AiKeysService],
})
export class AiKeysModule {}
