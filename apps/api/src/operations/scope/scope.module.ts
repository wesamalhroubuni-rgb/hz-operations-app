import { Module } from '@nestjs/common';
import { ScopeController } from './scope.controller';
import { ScopeService } from './scope.service';

@Module({
  controllers: [ScopeController],
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
