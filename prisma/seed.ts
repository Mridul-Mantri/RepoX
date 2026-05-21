/* eslint-disable no-console */
import { PrismaClient, UserRole, BuyerTier, KycStatus, VehicleCategory, FuelType,
  Transmission, VehicleCondition, SaleType, VehicleStatus, LotStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { generateLotNumber } from '../src/common/utils/codes';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding RepoX demo data...');

  // Reset — order matters for FK constraints
  console.log('  Wiping existing rows...');
  await prisma.bid.deleteMany();
  await prisma.savedVehicle.deleteMany();
  await prisma.vehicleImage.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.order.deleteMany();
  await prisma.lotApprovedBidder.deleteMany();
  await prisma.lotAccessRequest.deleteMany();
  await prisma.rfqResponseVehicle.deleteMany();
  await prisma.rfqResponse.deleteMany();
  await prisma.rfq.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.kycDocument.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.fraudAlert.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.user.deleteMany();
  await prisma.bank.deleteMany();
  await prisma.feeSetting.deleteMany();

  // ----- Fee settings ------------------------------------------------------
  await prisma.feeSetting.createMany({
    data: [
      { tier: BuyerTier.RETAIL, percent: 2.5, gstPercent: 18 },
      { tier: BuyerTier.DEALER, percent: 1.5, gstPercent: 18 },
      { tier: BuyerTier.ENTERPRISE, percent: 1.0, gstPercent: 18 },
    ],
  });

  // ----- Banks + Branches -------------------------------------------------
  console.log('  Creating banks...');
  const hdfc = await prisma.bank.create({
    data: {
      name: 'HDFC Bank', code: 'HDFC', type: 'BANK', isVerified: true,
      branches: { create: [
        { name: 'Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400058', contactPhone: '+912226781234' },
        { name: 'Bandra', city: 'Mumbai', state: 'Maharashtra', pincode: '400050' },
        { name: 'Koramangala', city: 'Bangalore', state: 'Karnataka', pincode: '560034' },
      ]},
    },
    include: { branches: true },
  });

  const icici = await prisma.bank.create({
    data: {
      name: 'ICICI Bank', code: 'ICICI', type: 'BANK', isVerified: true,
      branches: { create: [
        { name: 'Powai', city: 'Mumbai', state: 'Maharashtra', pincode: '400076' },
        { name: 'Connaught Place', city: 'Delhi', state: 'Delhi', pincode: '110001' },
      ]},
    },
    include: { branches: true },
  });

  const bajaj = await prisma.bank.create({
    data: {
      name: 'Bajaj Finance', code: 'BAJAJ', type: 'NBFC', isVerified: true,
      branches: { create: [
        { name: 'Pune HQ', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      ]},
    },
    include: { branches: true },
  });

  // ----- Users -------------------------------------------------------------
  console.log('  Creating users...');
  const pwdHash = await bcrypt.hash('password123', 10);

  const superAdmin = await prisma.user.create({
    data: {
      email: 'admin@repox.in', name: 'RepoX Admin', passwordHash: pwdHash,
      role: UserRole.SUPER_ADMIN, kycStatus: KycStatus.APPROVED,
      emailVerified: true,
    },
  });

  const bankStaffHdfc = await prisma.user.create({
    data: {
      email: 'staff@hdfc.repox.in', name: 'Priya HDFC', passwordHash: pwdHash,
      phone: '+919812345001', role: UserRole.BANK_STAFF, bankId: hdfc.id,
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });
  const bankStaffIcici = await prisma.user.create({
    data: {
      email: 'staff@icici.repox.in', name: 'Rohan ICICI', passwordHash: pwdHash,
      phone: '+919812345002', role: UserRole.BANK_STAFF, bankId: icici.id,
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });
  await prisma.user.create({
    data: {
      email: 'staff@bajaj.repox.in', name: 'Aarti Bajaj', passwordHash: pwdHash,
      phone: '+919812345003', role: UserRole.BANK_STAFF, bankId: bajaj.id,
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });

  // Retail buyer
  const retailBuyer = await prisma.user.create({
    data: {
      email: 'rahul@example.com', name: 'Rahul Sharma', passwordHash: pwdHash,
      phone: '+919876543210', role: UserRole.BUYER, buyerTier: BuyerTier.RETAIL,
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });
  // Dealer (small used-car shop)
  const dealerBuyer = await prisma.user.create({
    data: {
      email: 'sunil@krishnamotors.in', name: 'Sunil Patel', passwordHash: pwdHash,
      phone: '+919876543211', role: UserRole.BUYER, buyerTier: BuyerTier.DEALER,
      companyName: 'Krishna Motors', gstin: '27ABCDE1234F1Z5',
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });
  // Enterprise (fleet operator)
  const enterpriseBuyer = await prisma.user.create({
    data: {
      email: 'procurement@swiftfleet.in', name: 'Anita Kumar', passwordHash: pwdHash,
      phone: '+919876543212', role: UserRole.BUYER, buyerTier: BuyerTier.ENTERPRISE,
      companyName: 'SwiftFleet Logistics Pvt Ltd', gstin: '27FGHIJ5678K1Z2',
      kycStatus: KycStatus.APPROVED, emailVerified: true,
    },
  });
  // Pending KYC user (for admin demo)
  await prisma.user.create({
    data: {
      email: 'newbuyer@example.com', name: 'Vikram Singh', passwordHash: pwdHash,
      phone: '+919876543213', role: UserRole.BUYER, buyerTier: BuyerTier.RETAIL,
      kycStatus: KycStatus.PENDING, kycSubmittedAt: new Date(),
      kycDocuments: { create: [
        { type: 'PAN', documentUrl: 'https://demo-files.repox.in/pan-vikram.pdf', documentNumber: 'ABCDE1234F' },
        { type: 'AADHAAR', documentUrl: 'https://demo-files.repox.in/aadhaar-vikram.pdf' },
      ]},
    },
  });

  // ----- Vehicles ----------------------------------------------------------
  console.log('  Creating vehicles...');
  const now = Date.now();
  const tomorrow = new Date(now + 24 * 60 * 60 * 1000);
  const inThreeDays = new Date(now + 3 * 24 * 60 * 60 * 1000);
  const inAnHour = new Date(now + 60 * 60 * 1000);

  const swift = await prisma.vehicle.create({
    data: {
      bankId: hdfc.id, branchId: hdfc.branches[0].id, listedById: bankStaffHdfc.id,
      registrationNumber: 'MH01-AX-7849',
      make: 'Maruti Suzuki', model: 'Swift VXi', variant: 'VXi 1.2', year: 2019, color: 'White',
      category: VehicleCategory.HATCHBACK, fuelType: FuelType.PETROL,
      transmission: Transmission.MANUAL, kmDriven: 42000, ownerCount: 1,
      condition: VehicleCondition.B_PLUS,
      inspectionNotes: 'Regular service, minor scuff on rear bumper. AC works, all electricals OK.',
      saleType: SaleType.AUCTION, status: VehicleStatus.LIVE,
      reservePricePaise: 380_000n * 100n,   // ₹3.8L
      startingBidPaise: 250_000n * 100n,    // ₹2.5L
      currentBidPaise: 0n,
      auctionStartAt: new Date(now - 60 * 60 * 1000),
      auctionEndAt: inAnHour,
      images: { create: [
        { url: 'https://demo-files.repox.in/swift-1.jpg', position: 0, isPrimary: true },
        { url: 'https://demo-files.repox.in/swift-2.jpg', position: 1 },
      ]},
    },
  });

  const i20 = await prisma.vehicle.create({
    data: {
      bankId: icici.id, branchId: icici.branches[0].id, listedById: bankStaffIcici.id,
      registrationNumber: 'MH04-CK-2210',
      make: 'Hyundai', model: 'i20 Asta', variant: 'Asta 1.2', year: 2020, color: 'Polar White',
      category: VehicleCategory.HATCHBACK, fuelType: FuelType.PETROL,
      transmission: Transmission.MANUAL, kmDriven: 31500, ownerCount: 1,
      condition: VehicleCondition.A,
      saleType: SaleType.BUY_NOW, status: VehicleStatus.LIVE,
      reservePricePaise: 525_000n * 100n,
      buyNowPricePaise: 549_000n * 100n,    // ₹5.49L
      images: { create: [{ url: 'https://demo-files.repox.in/i20-1.jpg', position: 0, isPrimary: true }] },
    },
  });

  const xuv = await prisma.vehicle.create({
    data: {
      bankId: hdfc.id, branchId: hdfc.branches[2].id, listedById: bankStaffHdfc.id,
      registrationNumber: 'KA03-MZ-1188',
      make: 'Mahindra', model: 'XUV500 W8', variant: 'W8 AWD', year: 2018, color: 'Lakeside Brown',
      category: VehicleCategory.SUV, fuelType: FuelType.DIESEL,
      transmission: Transmission.MANUAL, kmDriven: 68000, ownerCount: 2,
      condition: VehicleCondition.B,
      saleType: SaleType.HYBRID, status: VehicleStatus.LIVE,
      reservePricePaise: 825_000n * 100n,
      startingBidPaise: 600_000n * 100n,
      buyNowPricePaise: 1_050_000n * 100n,
      auctionEndAt: tomorrow,
      images: { create: [{ url: 'https://demo-files.repox.in/xuv-1.jpg', position: 0, isPrimary: true }] },
    },
  });

  // Place a couple of bids to make the auction look alive
  await prisma.$transaction(async (tx) => {
    await tx.bid.create({
      data: { vehicleId: xuv.id, bidderId: dealerBuyer.id, amountPaise: 625_000n * 100n, isWinning: false },
    });
    await tx.bid.create({
      data: { vehicleId: xuv.id, bidderId: retailBuyer.id, amountPaise: 650_000n * 100n, isWinning: true },
    });
    await tx.vehicle.update({
      where: { id: xuv.id },
      data: { currentBidPaise: 650_000n * 100n, currentBidderId: retailBuyer.id, bidCount: 2 },
    });
  });

  // A sold vehicle so dashboards show something
  await prisma.vehicle.create({
    data: {
      bankId: icici.id, branchId: icici.branches[0].id, listedById: bankStaffIcici.id,
      registrationNumber: 'MH02-DL-4471',
      make: 'Honda', model: 'City VX', variant: 'VX CVT', year: 2017, color: 'Silver',
      category: VehicleCategory.SEDAN, fuelType: FuelType.PETROL,
      transmission: Transmission.AUTOMATIC, kmDriven: 71200, ownerCount: 2,
      condition: VehicleCondition.B,
      saleType: SaleType.BUY_NOW, status: VehicleStatus.SOLD,
      reservePricePaise: 480_000n * 100n,
      buyNowPricePaise: 495_000n * 100n,
      soldToId: retailBuyer.id, soldAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      soldPricePaise: 495_000n * 100n,
    },
  });

  // ----- A lot for enterprise demo ----------------------------------------
  console.log('  Creating lot...');
  const lotBikeIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const bike = await prisma.vehicle.create({
      data: {
        bankId: bajaj.id, branchId: bajaj.branches[0].id, listedById: superAdmin.id,
        registrationNumber: `MH12-PB-${1000 + i}`,
        make: 'Bajaj', model: 'Pulsar 150', variant: 'Pulsar 150 NS', year: 2020,
        category: VehicleCategory.BIKE, fuelType: FuelType.PETROL,
        transmission: Transmission.MANUAL, kmDriven: 18000 + i * 1200,
        condition: VehicleCondition.B,
        saleType: SaleType.LOT, status: VehicleStatus.LIVE,
        reservePricePaise: 55_000n * 100n,
      },
    });
    lotBikeIds.push(bike.id);
  }
  const lot = await prisma.lot.create({
    data: {
      lotNumber: generateLotNumber('MH'),
      bankId: bajaj.id, createdById: superAdmin.id,
      title: '6 × Bajaj Pulsar 150 — Pune branch',
      description: 'Single-owner, well-maintained Pulsar 150 fleet from a corporate buyback.',
      category: 'BIKE', region: 'Maharashtra',
      yearFrom: 2020, yearTo: 2020,
      reservePricePaise: 300_000n * 100n,
      isPrivate: false,
      auctionStartAt: new Date(now - 30 * 60 * 1000),
      auctionEndAt: inThreeDays,
      vehicleCount: lotBikeIds.length,
      status: LotStatus.OPEN,
      vehicles: { connect: lotBikeIds.map((id) => ({ id })) },
    },
  });
  // Attach a lot bid
  await prisma.bid.create({
    data: { lotId: lot.id, bidderId: enterpriseBuyer.id, amountPaise: 320_000n * 100n, isWinning: true },
  });
  await prisma.lot.update({
    where: { id: lot.id },
    data: { currentBidPaise: 320_000n * 100n, currentBidderId: enterpriseBuyer.id, bidCount: 1 },
  });

  // ----- An RFQ from the enterprise buyer ---------------------------------
  await prisma.rfq.create({
    data: {
      buyerId: enterpriseBuyer.id,
      title: '50 diesel cars in Maharashtra, under ₹3L each',
      description: 'Building a last-mile logistics fleet. Prefer 2018+, single owner, RC clean.',
      category: VehicleCategory.CAR,
      preferredMakes: ['Maruti Suzuki', 'Hyundai', 'Tata'],
      yearFrom: 2018, yearTo: 2021,
      fuelTypes: [FuelType.DIESEL],
      regions: ['Maharashtra'],
      quantity: 50,
      budgetPaise: 15_000_000n * 100n, // ₹1.5 Cr
      closesAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
  });

  // ----- Bank stats backfill ----------------------------------------------
  await prisma.bank.update({
    where: { id: hdfc.id },
    data: { vehiclesListed: 2, vehiclesSold: 0, totalRecoveredPaise: 0n },
  });
  await prisma.bank.update({
    where: { id: icici.id },
    data: { vehiclesListed: 2, vehiclesSold: 1, totalRecoveredPaise: 495_000n * 100n },
  });
  await prisma.bank.update({
    where: { id: bajaj.id },
    data: { vehiclesListed: 6, vehiclesSold: 0, totalRecoveredPaise: 0n },
  });

  console.log('✅ Seed complete.\n');
  console.log('Demo credentials (password: password123):');
  console.log('  Super admin   : admin@repox.in');
  console.log('  HDFC staff    : staff@hdfc.repox.in');
  console.log('  ICICI staff   : staff@icici.repox.in');
  console.log('  Bajaj staff   : staff@bajaj.repox.in');
  console.log('  Retail buyer  : rahul@example.com');
  console.log('  Dealer        : sunil@krishnamotors.in');
  console.log('  Enterprise    : procurement@swiftfleet.in');
  console.log('  Pending KYC   : newbuyer@example.com');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
