import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'platform:isPublic';

/** Marks a route (or controller) that needs no acting user, such as the health check. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
