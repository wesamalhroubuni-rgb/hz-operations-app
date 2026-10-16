import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createSiteSchema,
  idSchema,
  listSitesQuerySchema,
  siteListSchema,
  siteSchema,
  updateSiteSchema,
  type CreateSite,
  type ListSitesQuery,
  type Paginated,
  type Site,
  type UpdateSite,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { SitesService } from './sites.service';

@ApiTags('sites')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @Policy('site.read')
  @ApiDocs({ summary: 'List sites', query: listSitesQuerySchema, response: siteListSchema })
  list(@Query(new ZodPipe(listSitesQuerySchema)) query: ListSitesQuery): Promise<Paginated<Site>> {
    return this.sites.list(query);
  }

  @Get(':id')
  @Policy('site.read')
  @ApiDocs({
    summary: 'Get a site',
    response: siteSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.get(id);
  }

  @Post()
  @Policy('site.manage')
  @ApiDocs({
    summary: 'Create a site',
    body: createSiteSchema,
    response: siteSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createSiteSchema)) body: CreateSite): Promise<Site> {
    return this.sites.create(body);
  }

  @Patch(':id')
  @Policy('site.manage')
  @ApiDocs({
    summary: 'Update a site',
    body: updateSiteSchema,
    response: siteSchema,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.UNPROCESSABLE_ENTITY,
    ],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateSiteSchema)) body: UpdateSite,
  ): Promise<Site> {
    return this.sites.update(id, body);
  }

  @Post(':id/archive')
  @Policy('site.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a site',
    response: siteSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.archive(id);
  }

  @Post(':id/restore')
  @Policy('site.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived site',
    response: siteSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.restore(id);
  }
}
