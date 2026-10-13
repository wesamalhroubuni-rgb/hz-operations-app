import { Global, Module } from '@nestjs/common';
import { ChangeRecorder } from './change-recorder';

/** Helpers shared by every Operations module. */
@Global()
@Module({
  providers: [ChangeRecorder],
  exports: [ChangeRecorder],
})
export class OperationsCommonModule {}
