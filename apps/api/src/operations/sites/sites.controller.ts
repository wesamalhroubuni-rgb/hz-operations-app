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
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { SitesService } from './sites.service';

@ApiTags('sites')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @ApiDocs({ summary: 'List sites', query: listSitesQuerySchema, response: siteListSchema })
  list(@Query(new ZodPipe(listSitesQuerySchema)) query: ListSitesQuery): Promise<Paginated<Site>> {
    return this.sites.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({ summary: 'Get a site', response: siteSchema, errors: [HttpStatus.NOT_FOUND] })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Create a site',
    body: createSiteSchema,
    response: siteSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createSiteSchema)) body: CreateSite): Promise<Site> {
    return this.sites.create(requireActor().organizationId, body);
  }

  @Patch(':id')
  @ApiDocs({
    summary: 'Update a site',
    body: updateSiteSchema,
    response: siteSchema,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateSiteSchema)) body: UpdateSite,
  ): Promise<Site> {
    return this.sites.update(requireActor().organizationId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({ summary: 'Archive a site', response: siteSchema, errors: [HttpStatus.NOT_FOUND] })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.archive(requireActor().organizationId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived site',
    response: siteSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Site> {
    return this.sites.restore(requireActor().organizationId, id);
  }
}
