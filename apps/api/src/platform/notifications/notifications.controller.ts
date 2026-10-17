import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  idSchema,
  listNotificationsQuerySchema,
  notificationListSchema,
  notificationSchema,
  registerPushTokenSchema,
  type AppNotification,
  type ListNotificationsQuery,
  type NotificationList,
  type RegisterPushToken,
} from '@ops/shared';
import { Authenticated } from '../authz/policy.decorator';
import { ApiDocs, requireActor, ZodPipe } from '../http';
import { NotificationInboxService } from './notification-inbox.service';
import { PushTokenService } from './push-tokens.service';

const pushTokenParamSchema = registerPushTokenSchema.shape.token;

/**
 * The signed-in user's own notifications and push devices. Every route is self-service
 * (`@Authenticated`): it acts on the caller alone, whatever their role.
 */
@ApiTags('notifications')
@Controller('notifications')
@Authenticated()
export class NotificationsController {
  constructor(
    private readonly inbox: NotificationInboxService,
    private readonly pushTokens: PushTokenService,
  ) {}

  @Get()
  @ApiDocs({
    summary: 'Your notifications',
    description:
      'Newest first. `unread=true` lists only unread ones. `unreadCount` is the total of unread ' +
      'notifications, whatever the filter and page.',
    query: listNotificationsQuerySchema,
    response: notificationListSchema,
  })
  list(
    @Query(new ZodPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<NotificationList> {
    return this.inbox.list(query);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Mark all your notifications read',
    status: HttpStatus.NO_CONTENT,
  })
  async readAll(): Promise<void> {
    await this.inbox.markAllRead();
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Mark one of your notifications read',
    description: 'Somebody else’s notification answers 404, like one that does not exist.',
    params: { id: idSchema },
    response: notificationSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  markRead(@Param('id', new ZodPipe(idSchema)) id: string): Promise<AppNotification> {
    return this.inbox.markRead(id);
  }

  @Post('push-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Register this device for push notifications',
    description:
      'Binds the Expo push token to you and to the current session: signing out (or any other ' +
      'end of the session) removes it. Registering again is harmless; a token registered by ' +
      'another session or user moves to this one. One token per session: a new token replaces ' +
      'the previous one of the same session.',
    body: registerPushTokenSchema,
    status: HttpStatus.NO_CONTENT,
  })
  async registerPushToken(
    @Body(new ZodPipe(registerPushTokenSchema)) body: RegisterPushToken,
  ): Promise<void> {
    await this.pushTokens.register(requireActor(), body);
  }

  @Delete('push-tokens/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Unregister one of your devices',
    description: 'Only your own token; any other answers 404. URL-encode the token.',
    params: { token: pushTokenParamSchema },
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.NOT_FOUND],
  })
  async unregisterPushToken(
    @Param('token', new ZodPipe(pushTokenParamSchema)) token: string,
  ): Promise<void> {
    await this.pushTokens.unregister(requireActor(), token);
  }
}
