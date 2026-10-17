import { Module } from '@nestjs/common';
import { AttachmentCleanupService } from './attachment-cleanup.service';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentCleanupService],
  exports: [AttachmentsService, AttachmentCleanupService],
})
export class AttachmentsModule {}
