import { Body, Controller, Get, HttpStatus, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  organizationFullSchema,
  organizationSchema,
  updateOrganizationSchema,
  type Organization,
  type OrganizationFull,
  type UpdateOrganization,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { OrganizationService } from './organization.service';

@ApiTags('organization')
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  @Policy('organization.read')
  @ApiDocs({
    summary: "Get the signed-in user's organization",
    description:
      'Admins get the `full` view (with the settings); everyone else the `summary` view (name, ' +
      'slug and the work-log edit window).',
    response: organizationSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  get(): Promise<Organization> {
    return this.organization.get();
  }

  @Patch()
  @Policy('organization.update')
  @ApiDocs({
    summary: "Update the organization's name or settings",
    description: 'Admins only. `settings.workLogEditWindowHours` sets the work-log edit window.',
    body: updateOrganizationSchema,
    response: organizationFullSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  update(
    @Body(new ZodPipe(updateOrganizationSchema)) body: UpdateOrganization,
  ): Promise<OrganizationFull> {
    return this.organization.update(body);
  }
}
