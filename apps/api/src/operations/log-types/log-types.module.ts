import { Module } from '@nestjs/common';
import { LogTypesController } from './log-types.controller';
import { LogTypesService } from './log-types.service';

@Module({
  controllers: [LogTypesController],
  providers: [LogTypesService],
  exports: [LogTypesService],
})
export class LogTypesModule {}
