#!/usr/bin/env bash
# =============================================================================
#  RepoX backend smoke test
#  Walks the happy path: register → KYC-auto → browse → hold → checkout → verify
#
#  Prereqs: jq, curl, the API running on $BASE_URL
#  Run:  ./scripts/smoke.sh
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000/api/v1}"

echo "→ Logging in as rahul (retail buyer, seeded)..."
LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"rahul@example.com","password":"password123"}')
TOKEN=$(echo "$LOGIN" | jq -r .accessToken)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "Login failed: $LOGIN"; exit 1; }
echo "   ✓ Got access token"

echo "→ Listing vehicles..."
VEHICLES=$(curl -s "$BASE_URL/vehicles?saleType=BUY_NOW&limit=5")
VEHICLE_ID=$(echo "$VEHICLES" | jq -r '.items[0].id')
[ -n "$VEHICLE_ID" ] && [ "$VEHICLE_ID" != "null" ] || { echo "No vehicles found"; exit 1; }
echo "   ✓ First BUY_NOW vehicle: $VEHICLE_ID"

echo "→ Reserving (POST /vehicles/$VEHICLE_ID/hold)..."
HOLD=$(curl -s -X POST "$BASE_URL/vehicles/$VEHICLE_ID/hold" \
  -H "Authorization: Bearer $TOKEN")
HELD_UNTIL=$(echo "$HOLD" | jq -r .heldUntil)
echo "   ✓ Held until: $HELD_UNTIL"

echo "→ Starting checkout..."
ORDER=$(curl -s -X POST "$BASE_URL/orders/checkout" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEHICLE_ID\",\"method\":\"UPI\",\"upiId\":\"test@upi\"}")
ORDER_ID=$(echo "$ORDER" | jq -r '.order.id')
ORDER_NUM=$(echo "$ORDER" | jq -r '.order.orderNumber')
RZ_ORDER_ID=$(echo "$ORDER" | jq -r '.razorpay.orderId')
echo "   ✓ Order $ORDER_NUM (razorpay: $RZ_ORDER_ID)"

echo "→ Verifying payment (mock mode — any signature works)..."
VERIFY=$(curl -s -X POST "$BASE_URL/orders/$ORDER_ID/verify-payment" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"razorpayPaymentId":"pay_mock_1234567890","razorpaySignature":"mock_sig"}')
PASS=$(echo "$VERIFY" | jq -r .pickupPassCode)
echo "   ✓ Pickup pass: $PASS"

echo "→ Fetching my orders..."
curl -s "$BASE_URL/orders/mine" -H "Authorization: Bearer $TOKEN" | jq '.[0] | {orderNumber, status, totalAmountPaise}'

echo ""
echo "✅ Smoke test complete. Open Swagger at $BASE_URL/../docs to explore more."
