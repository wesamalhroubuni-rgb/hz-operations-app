import { Body, Controller, Delete, Get, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  aiKeyProviderSchema,
  aiProviderKeysSchema,
  setAiProviderKeySchema,
  type AiKeyProvider,
  type AiProviderKeys,
  type SetAiProviderKey,
} from '@ops/shared';
import { Policy } from '../../../platform/authz';
import { ApiDocs, ZodPipe } from '../../../platform/http';
import { AiKeysService } from './ai-keys.service';

@ApiTags('ai')
@Controller('ai/keys')
export class AiKeysController {
  constructor(private readonly keys: AiKeysService) {}

  @Get()
  @Policy('ai_key.manage')
  @ApiDocs({
    summary: "Where the organization's AI provider keys come from",
    description:
      'Admins only. For Claude (anthropic) and OpenAI: whether the organization stored its own ' +
      "key (then its last four characters), uses the server's key, the built-in test AI, or none. " +
      'Never returns a key.',
    response: aiProviderKeysSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  status(): Promise<AiProviderKeys> {
    return this.keys.status();
  }

  @Put(':provider')
  @Policy('ai_key.manage')
  @ApiDocs({
    summary: "Save the organization's own AI provider key",
    description:
      'Admins only. The key is checked with the provider (reading the configured model, which ' +
      'generates nothing) and stored encrypted; it replaces any key saved before. 422 ' +
      '`ai_key_invalid` when the provider refuses it, 503 `ai_unavailable` when the provider ' +
      'cannot be reached, 503 `ai_key_storage_unavailable` without AI_KEYS_ENCRYPTION_SECRET.',
    params: { provider: aiKeyProviderSchema },
    body: setAiProviderKeySchema,
    response: aiProviderKeysSchema,
    errors: [
      HttpStatus.BAD_REQUEST,
      HttpStatus.FORBIDDEN,
      HttpStatus.UNPROCESSABLE_ENTITY,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  set(
    @Param('provider', new ZodPipe(aiKeyProviderSchema)) provider: AiKeyProvider,
    @Body(new ZodPipe(setAiProviderKeySchema)) body: SetAiProviderKey,
  ): Promise<AiProviderKeys> {
    return this.keys.set(provider, body.apiKey);
  }

  @Delete(':provider')
  @Policy('ai_key.manage')
  @ApiDocs({
    summary: "Remove the organization's own AI provider key",
    description:
      "Admins only. Deletes the stored key; the server's key or the test AI apply again. " +
      'Removing a key that is not stored answers the status unchanged.',
    params: { provider: aiKeyProviderSchema },
    response: aiProviderKeysSchema,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN],
  })
  remove(
    @Param('provider', new ZodPipe(aiKeyProviderSchema)) provider: AiKeyProvider,
  ): Promise<AiProviderKeys> {
    return this.keys.remove(provider);
  }
}
