import { Module } from '@nestjs/common';
import { WorkLogsController } from './work-logs.controller';
import { WorkLogsService } from './work-logs.service';

@Module({
  controllers: [WorkLogsController],
  providers: [WorkLogsService],
  exports: [WorkLogsService],
})
export class WorkLogsModule {}
