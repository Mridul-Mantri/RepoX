import {
  Injectable, BadRequestException, ForbiddenException, GoneException, NotFoundException,
} from '@nestjs/common';
import { BuyerTier, RfqStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CreateRfqDto, RespondToRfqDto } from './rfqs.dto';

/**
 * RFQ (Request for Quotation) — the dealer/enterprise procurement workflow.
 * A bulk buyer posts what they want ("50 diesel cars in Maharashtra under
 * ₹3L each"), banks respond with quotes, the buyer picks one.
 */
@Injectable()
export class RfqsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(user: AuthUser, dto: CreateRfqDto) {
    if (user.buyerTier === BuyerTier.RETAIL) {
      throw new ForbiddenException('Only dealer and enterprise tiers can post RFQs');
    }

    const rfq = await this.prisma.rfq.create({
      data: {
        buyerId: user.id,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        preferredMakes: dto.preferredMakes ?? [],
        yearFrom: dto.yearFrom,
        yearTo: dto.yearTo,
        fuelTypes: dto.fuelTypes ?? [],
        regions: dto.regions ?? [],
        quantity: dto.quantity,
        budgetPaise: BigInt(dto.budgetPaise),
        closesAt: dto.closesAt ? new Date(dto.closesAt) : null,
        status: RfqStatus.OPEN,
      },
    });

    await this.activity.log({
      type: 'RFQ_CREATED', actorId: user.id,
      message: `RFQ posted: "${rfq.title}" (qty ${dto.quantity})`,
      meta: { rfqId: rfq.id },
    });

    // Banks subscribe to a broadcast channel for new RFQs
    this.realtime.broadcast('rfq:new', { id: rfq.id, title: rfq.title });

    return rfq;
  }

  async mine(user: AuthUser) {
    return this.prisma.rfq.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        responses: {
          include: {
            bank: { select: { id: true, name: true, code: true, logoUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async incomingForBanks(_user: AuthUser) {
    return this.prisma.rfq.findMany({
      where: { status: { in: [RfqStatus.OPEN, RfqStatus.RESPONDED] } },
      orderBy: { createdAt: 'desc' },
      include: {
        buyer: { select: { id: true, name: true, companyName: true, buyerTier: true } },
        _count: { select: { responses: true } },
      },
    });
  }

  async respond(user: AuthUser, rfqId: string, dto: RespondToRfqDto) {
    if (!user.bankId) throw new ForbiddenException('Only bank staff can respond to RFQs');

    const rfq = await this.prisma.rfq.findUnique({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (rfq.status === RfqStatus.CLOSED || rfq.status === RfqStatus.EXPIRED) {
      throw new GoneException(`RFQ is ${rfq.status}`);
    }
    if (rfq.closesAt && rfq.closesAt < new Date()) {
      throw new GoneException('RFQ has expired');
    }

    const response = await this.prisma.$transaction(async (tx) => {
      const created = await tx.rfqResponse.create({
        data: {
          rfqId, bankId: user.bankId!, respondedById: user.id,
          quotedPricePaise: BigInt(dto.quotedPricePaise),
          availableUnits: dto.availableUnits,
          notes: dto.notes,
          vehicleLinks: dto.vehicleIds?.length
            ? { create: dto.vehicleIds.map((vehicleId) => ({ vehicleId })) }
            : undefined,
        },
      });
      await tx.rfq.update({
        where: { id: rfqId },
        data: { status: RfqStatus.RESPONDED },
      });
      return created;
    });

    await this.activity.log({
      type: 'RFQ_RESPONSE', actorId: user.id,
      message: `Bank responded to RFQ "${rfq.title}" with ${dto.availableUnits} units`,
      meta: { rfqId, responseId: response.id },
    });

    this.realtime.toUser(rfq.buyerId, 'rfq:response', {
      rfqId, responseId: response.id,
    });

    return response;
  }

  async acceptResponse(user: AuthUser, rfqId: string, responseId: string) {
    const rfq = await this.prisma.rfq.findUnique({
      where: { id: rfqId },
      include: { responses: { where: { id: responseId } } },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (rfq.buyerId !== user.id) throw new ForbiddenException('Not your RFQ');
    if (rfq.responses.length === 0) throw new NotFoundException('Response not found');
    if (rfq.status === RfqStatus.CLOSED || rfq.status === RfqStatus.FULFILLED) {
      throw new BadRequestException(`RFQ is ${rfq.status}`);
    }

    const updated = await this.prisma.rfq.update({
      where: { id: rfqId },
      data: { acceptedResponseId: responseId, status: RfqStatus.ACCEPTED },
    });

    this.realtime.toUser(rfq.responses[0].bankId, 'rfq:accepted', {
      rfqId, responseId,
    });

    return updated;
  }
}
