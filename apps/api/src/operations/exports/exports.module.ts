import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/** CSV exports of work logs and tasks (Phase 6, ADR-0009). */
@Module({
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
