import { Module } from '@nestjs/common';
import { ScopeController } from './scope.controller';

/** The scope inspection endpoints. The scope service is provided by the global AccessModule. */
@Module({
  controllers: [ScopeController],
})
export class ScopeModule {}
