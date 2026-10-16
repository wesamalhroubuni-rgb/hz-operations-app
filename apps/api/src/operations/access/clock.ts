import { Injectable } from '@nestjs/common';

/**
 * The time the access rules are evaluated at (the work-log edit window). A provider of its own
 * so a test can replace it and move time without waiting.
 */
@Injectable()
export class AccessClock {
  now(): Date {
    return new Date();
  }
}
