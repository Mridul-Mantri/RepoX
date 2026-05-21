// Postgres returns BIGINT columns as JS BigInt via Prisma. Express's default
// JSON.stringify throws on BigInt — patch it once at boot.
//
// We serialize BigInt as a string so the client never silently loses precision
// for big paise amounts.

if (typeof (BigInt.prototype as any).toJSON !== 'function') {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

export {};
