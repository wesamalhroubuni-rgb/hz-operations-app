import { Module } from '@nestjs/common';
import { RecordHistoryService } from './record-history.service';

/** Record histories from the audit log; the routes live on the work-log and task controllers. */
@Module({
  providers: [RecordHistoryService],
  exports: [RecordHistoryService],
})
export class HistoryModule {}
