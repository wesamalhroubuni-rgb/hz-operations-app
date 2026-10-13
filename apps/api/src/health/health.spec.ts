import { HttpStatus, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('GET /health', () => {
  const ping = jest.fn<Promise<void>, []>();
  const status = jest.fn();
  const response = { status };
  let controller: HealthController;

  beforeEach(async () => {
    ping.mockReset();
    status.mockReset();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: PrismaService, useValue: { ping } }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports ok / up when the database answers', async () => {
    ping.mockResolvedValue(undefined);

    const body = await controller.getHealth(response);

    expect(ping).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('responds 503 with error / down when the database is unreachable', async () => {
    ping.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const body = await controller.getHealth(response);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toMatchObject({ status: 'error', database: 'down' });
  });

  it('never writes the connection string to the logs', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error');
    ping.mockRejectedValue(new Error('cannot reach postgresql://user:secret@db:5432/app'));

    await controller.getHealth(response);

    const logged = errorLog.mock.calls.flat().join(' ');
    expect(logged).toContain('Database health check failed');
    expect(logged).not.toContain('secret');
  });
});
