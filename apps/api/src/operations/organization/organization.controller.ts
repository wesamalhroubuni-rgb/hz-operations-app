import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  organizationSchema,
  updateOrganizationSchema,
  type Organization,
  type UpdateOrganization,
} from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { OrganizationService } from './organization.service';

@ApiTags('organization')
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  @ApiDocs({ summary: "Get the acting user's organization", response: organizationSchema })
  get(): Promise<Organization> {
    return this.organization.get(requireActor().organizationId);
  }

  @Patch()
  @ApiDocs({
    summary: "Update the organization's name or settings",
    body: updateOrganizationSchema,
    response: organizationSchema,
  })
  update(
    @Body(new ZodPipe(updateOrganizationSchema)) body: UpdateOrganization,
  ): Promise<Organization> {
    return this.organization.update(requireActor().organizationId, body);
  }
}
