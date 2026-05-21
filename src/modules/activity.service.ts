import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityLevel, Prisma } from '@prisma/client';

export interface LogEntry {
  type: string;
  level?: ActivityLevel;
  actorId?: string;
  message: string;
  meta?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Writes to the activity_log table. Designed to never throw — a logging failure
 * must not break the calling request.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: LogEntry) {
    try {
      return await this.prisma.activityLog.create({
        data: {
          type: entry.type,
          level: entry.level ?? ActivityLevel.INFO,
          actorId: entry.actorId,
          message: entry.message,
          meta: entry.meta,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent?.slice(0, 200),
        },
      });
    } catch (err: any) {
      this.logger.error(`Activity log write failed: ${err.message}`);
      return null;
    }
  }

  async list(opts: { level?: ActivityLevel; type?: string; limit?: number; cursor?: string }) {
    return this.prisma.activityLog.findMany({
      where: {
        ...(opts.level ? { level: opts.level } : {}),
        ...(opts.type ? { type: opts.type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      include: { actor: { select: { id: true, name: true, email: true, role: true } } },
    });
  }
}
